# Progress

## Process Follow-ups

### #136 Validation fallback for dependency-less worktrees

- Status: documentation update complete locally on `codex/issue-136-validation-fallback-docs`; PR handoff pending.
- Scope: document local validation recovery for fresh git worktrees that do not have `node_modules` yet.
- Non-goals: no package scripts, dependencies, lockfiles, CI, app behavior, test behavior, or changelog entries.
- Current docs change: `README.md` now records the preferred `bun install --frozen-lockfile` recovery and the narrow checker-only `PATH=/path/to/main/node_modules/.bin:$PATH bun run format:check` fallback, including the requirement to record that no files were modified.
- Validation evidence:
  - `bun install --frozen-lockfile`: pass; installed committed dependencies because this fresh worktree had no `node_modules`.
  - `bun run format:check`: pass; Biome checked 117 files with no fixes applied.
  - `bun run lint`: pass; Biome lint checked 117 files with no fixes applied.
  - `bun run typecheck`: pass; `tsc --noEmit` completed.
  - `git diff --check`: pass; no whitespace errors.
  - Targeted `rg` checks confirmed `README.md` contains the fresh-worktree recovery note, `bun install --frozen-lockfile`, the checker fallback example, and the no-files-modified recording requirement.
  - Broader tests, build, and E2E were not run because #136 is documentation-only validation workflow guidance with no app or test behavior changes.

## Milestone 11 Manual VPS Deployment

- Status: #126 local documentation and validation evidence complete; Milestone 11 is not complete because an authorized hosted dashboard plus manual VPS smoke target is not available in this worktree.
- Source plan:
  - `docs/MILESTONES.md` Milestone 11: Single Cloud VM Deployment.
  - GitHub issue #126.
- Current branch: `codex/issue-126-manual-vps-docs-smoke`.
- External blocker: real hosted-dashboard/manual-VPS smoke requires authorized dashboard URL, runner endpoint, temporary bearer token, hosted database/Vercel env access, and permission to mutate staging runner containers. These were not provided, and this work must not perform production deploys, DNS/VPS mutation, secret changes, or real credential use without explicit authorization.

### Issue Checklist

- [x] #122 Persist manual VPS runner identity and assignment.
- [x] #123 Add standalone manual VPS runner service.
- [x] #124 Forward dashboard lifecycle actions to assigned manual runners.
- [x] #125 Show manual runner status and failures.
- [x] #126 Document and smoke-test manual VPS deployment. Status: local docs/evidence complete; external hosted/manual-VPS smoke blocked by missing authorized environment.

### Current Status

- README now documents manual VPS prerequisites, Docker and Bun setup, runner service startup/supervision, firewall/HTTPS expectations, dashboard configuration, troubleshooting, and an operator smoke procedure.
- `.env.example` lists dashboard and runner env vars with placeholders only.
- Stale README language was reconciled so manual runner persistence, lifecycle forwarding, remote logs, and runner status UI are described as shipped behavior, while provisioning, production auth, Hermes/provider integrations, backups, billing, and automated cloud APIs remain future scope.
- `docs/MILESTONES.md` intentionally does not mark Milestone 11 completed because the real hosted/manual-VPS smoke acceptance gate is externally blocked.
- `CHANGELOG.md` is intentionally unchanged for #126 because this issue adds docs and a manual smoke procedure, not new observable app behavior or a new smoke command.

### Validation Evidence

- 2026-07-05 #126:
  - `bun install`: pass; restored local package binaries after initial `bun run format:check` and `bun run lint` failed with `biome: command not found`.
  - Initial `bun run format:check`: environment failure before install; `biome` binary was unavailable in the worktree.
  - Initial `bun run lint`: environment failure before install; `biome` binary was unavailable in the worktree.
  - `bun run format:check`: pass; Biome checked 102 files with no fixes applied.
  - `bun run lint`: pass; Biome checked 102 files with no fixes applied.
  - `bun run typecheck`: pass; `tsc --noEmit` completed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- tests/unit/manual-runner-adapter.test.ts tests/unit/runner-service.test.ts tests/unit/manual-runner-status.test.ts tests/unit/agent-logs-route.test.ts`: pass; 31 focused manual runner adapter/service/status/log tests passed.
  - `docker compose up -d postgres`: failed; the issue-local compose project could not bind host port `54329` because the shared AgentBay Postgres was already using it. Follow-up `docker compose down -v --remove-orphans` removed the failed issue-local container, network, and volume.
  - First `bun run test -- --no-file-parallelism`: environment failure; command was run without `DATABASE_URL`/`NEXT_PUBLIC_APP_URL`, causing env validation failures before DB-backed suites initialized.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:migrate`: pass; migrations applied successfully against the shared local database.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:health`: pass; returned `status: ok` and `database: reachable`.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism`: pass; 29 files and 262 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: pass; Next.js production build completed and listed the expected app/API routes.
  - `PORT=3126 DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3126 bun run test:e2e -- --project=chromium-desktop --project=chromium-mobile -g "manual runner status"`: pass; 2 tests passed covering dashboard runner status, assigned-runner detail, unreachable/offline alerts, remote/manual runner logs, safe omission of raw endpoint credentials, and mobile layout.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run verify`: failed during the default parallel Vitest step after format, lint, and typecheck passed. Failures were shared-DB parallelism symptoms already known in this repo: one manual-runner adapter log assertion received no rows after a parallel deadlock, and one create-agent lifecycle test hit `AgentLifecyclePersistenceError`.
  - `PORT=3126 DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3126 bun run test:e2e -- --workers=1`: pass; 41 tests passed and 19 expected project skips.
  - `rg -n "lifecycle forwarding.*future scope|remote runner control APIs.*future scope|runner tokens.*future scope|heartbeats.*future scope|remote logs.*future scope|manual runner.*future scope|runner status.*future scope" README.md docs/MILESTONES.md PROGRESS.md -S`: pass; no stale shipped-manual-runner feature wording remains. Matches were only current future-scope statements for unimplemented production/provisioning areas and the #126 reconciliation note.
  - Secret scan over README, `.env.example`, `PROGRESS.md`, `CHANGELOG.md`, `docs/MILESTONES.md`, and tests: pass; no committed real tokens, private keys, provider keys, production DB URLs, or non-placeholder runner bearer values found.
  - `git diff --check`: pass; no whitespace errors.
  - Final `bun run format:check`: pass; Biome checked 102 files with no fixes applied after the final README edit.
  - External smoke: blocked; no authorized hosted dashboard URL, manual VPS endpoint, temporary bearer token, hosted database/Vercel env access, or permission to mutate staging runner containers was provided.

## Milestone 13 Cloud Provisioning V1

- Status: #155 final assignment, cleanup, and evidence slice is locally complete on `codex/issue-155-m13-acceptance`; checker handoff pending.
- Source plan:
  - `docs/MILESTONES.md` Milestone 13: Cloud Provisioning V1.
  - GitHub issue #150: Prepare Milestone 13 tracking and baseline gates.
  - `PLAN.md` is absent in this worktree; the published #150 issue body and `docs/MILESTONES.md` are the active Step 0 contract.
- Current branch: `codex/issue-155-m13-acceptance`.

### Issue Checklist

- [x] #150 Prepare Milestone 13 tracking and baseline gates. Status: merged in PR #169.
- [x] #151 Add cloud runner provisioning model and provider contract. Status: merged in PR #170.
- [x] #152 Implement Create runner provisioning workflow. Status: merged in PR #171.
- [x] #153 Add cloud runner bootstrap registration and readiness. Status: merged in PR #172.
- [x] #154 Show cloud provisioning progress and failures in the UI. Status: merged in PR #173.
- [x] #155 Complete assignment, cleanup, and Milestone 13 evidence. Status: locally complete; checker handoff pending.

### Current Status

- Milestone 13 goal from `docs/MILESTONES.md`: automatically create a DigitalOcean runner without exposing cloud setup to the user.
- Milestone 13 acceptance criteria: user can click Create runner and see provisioning progress; a Droplet is created; the runner installs itself and registers; the dashboard shows the runner `online`; a user can create or assign an agent to the new runner; provisioning failure is visible and actionable.
- Milestone 13 test expectations from `docs/MILESTONES.md`: provider unit tests with a fake DigitalOcean client, provisioning job success/failure tests, one real small-Droplet smoke before beta, and a security test that provider credentials are never exposed to the browser.
- #150 is tracking-only. It initializes the Milestone 13 progress record, records baseline gate expectations, verifies changelog structure, and intentionally leaves `CHANGELOG.md` unchanged because no functional user/operator-visible behavior ships in this issue.
- #151 adds the durable cloud runner provisioning foundation: `runners.kind` can now represent `digitalocean`, DigitalOcean runner rows store provider, provider resource id, region, size slug, image, provisioning status, provisioning error, and provisioning timing fields, and manual VPS rows continue to require a non-empty endpoint.
- #151 adds a server-only DigitalOcean provider configuration reader and fake provider abstraction for create, tag, firewall, cleanup, and failure-path tests without network calls. Provider tokens remain out of client env validation and client component import paths.
- #152 adds backend `POST /api/runners` provisioning for the development user. The route validates DigitalOcean create-runner input, creates a provisioning runner plus hash-only one-time registration token, persists phase events for refresh-safe progress, calls the DigitalOcean API provider create/tag/firewall contract with fakeable tests, returns duplicate-submit state for an in-progress runner, and reports provider failures as actionable safe runner state without exposing provider credentials or registration secrets.
- #153 adds server-generated cloud runner bootstrap content and a runner-side bootstrap command that reuses the existing one-time registration-token exchange, credential lifecycle, and heartbeat path so DigitalOcean runners move from bootstrapping to registering to ready without a second auth mechanism.
- #154 adds settings and dashboard cloud-runner provisioning surfaces backed by persisted runner state and the merged #152 `POST /api/runners` endpoint. The UI renders only safe DTO fields: provider, region, size, image, provisioning phase, readiness, heartbeat timing, and redacted failure guidance.
- #155 completes the final Milestone 13 acceptance slice: online DigitalOcean runners can be assigned to active agents and started through the existing remote runner adapter path, failed provisioning after Droplet creation attempts safe owned-resource cleanup, unsafe cleanup returns explicit manual instructions, and `docs/MILESTONE_13_CLOUD_PROVISIONING_SMOKE.md` records the opt-in pre-beta real-Droplet smoke checklist.
- Final Milestone 13 acceptance map:
  - Create runner and progress visibility: #152 backend provisioning tests plus #154 settings/dashboard unit and browser smoke coverage.
  - Droplet creation: #151 fake provider contract tests and #152 provisioning service tests cover the DigitalOcean create/tag/firewall contract without network calls; `docs/MILESTONE_13_CLOUD_PROVISIONING_SMOKE.md` defines the required real small-Droplet beta gate.
  - Runner install and registration: #153 bootstrap, registration, heartbeat, and readiness tests cover cloud-init content, runner-side bootstrap, one-time registration exchange, and first-heartbeat readiness.
  - Dashboard online state: #154 page and E2E coverage renders persisted online heartbeat readiness and keeps state after reload.
  - Agent assignment: #155 DB/lifecycle coverage proves an online `digitalocean` runner can be assigned to an active agent and started through the assigned-runner adapter path.
  - Actionable provisioning failure: #152 safe create-failure coverage plus #155 post-create cleanup/manual-cleanup coverage prove browser-safe actionable failure states.
  - Security: #151 server-only provider config tests, #152 route/service secret-safety assertions, #153 bootstrap redaction tests, #154 safe DTO/UI assertions, and #155 assignment/cleanup safety tests cover provider credentials, registration secrets, runner credentials, hashes, and browser-visible output.
- `CHANGELOG.md` has the Keep a Changelog 1.0.0 framing and an `## [Unreleased]` section. Agents should keep that structure and add changelog bullets only for shipped functional user/operator-visible changes.

### Baseline Gate Expectations

- Default local database for verify, DB-backed unit tests, migrations, health checks, and default E2E: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay`.
- Default local app URL for verify and E2E: `NEXT_PUBLIC_APP_URL=http://localhost:3000`.
- Default E2E server URL: `PORT=3000` and `PLAYWRIGHT_BASE_URL=http://localhost:3000` unless an issue uses an isolated port; when an isolated E2E port is used, set `PORT`, `PLAYWRIGHT_BASE_URL`, and `NEXT_PUBLIC_APP_URL` to the same localhost port.
- Canonical aggregate gate: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run verify`.
- Required #150 baseline commands: `bun run format:check` and `git diff --check`.
- Known repo caveat from Milestone 12 evidence: default-parallel DB-backed Vitest inside `bun run verify` has previously failed from shared-DB isolation races. If this repeats, rerun the relevant branch command and prove whether the same failure reproduces on current `main` before calling it baseline.

### Update Rules

- Every Milestone 13 implementation issue must update this section after validation with the issue number, changed behavior, commands run, pass/fail result, skipped checks with reasons, and remaining risks.
- Keep DigitalOcean credentials, cloud provider secrets, bearer tokens, production URLs, and provisioning credentials out of committed docs, UI output, tests, logs, and status messages.
- Update `CHANGELOG.md` only for shipped functional user/operator-visible changes. Do not add changelog entries for tracking-only, validation-only, test-only, or documentation-only work.
- Preserve Milestone 14 and Milestone 15 as future scope; do not add multi-agent capacity, backup, restore, billing, production deploy, or unrelated provider work while executing Milestone 13.

### Update Log

- 2026-07-06: #150 initialized Milestone 13 tracking from `docs/MILESTONES.md` and the published #150 issue body; noted that `PLAN.md` is absent in this worktree and the published issue body plus milestone document are the active Step 0 contract.
- 2026-07-06: #150 confirmed `CHANGELOG.md` has Keep a Changelog 1.0.0 framing and `## [Unreleased]`; `CHANGELOG.md` is intentionally unchanged for #150 because this issue creates tracking only and ships no functional product behavior.
- 2026-07-06: #150 recorded baseline gate expectations for `bun run verify`, `bun run test:e2e`, the local Postgres `DATABASE_URL`, and `NEXT_PUBLIC_APP_URL` before cloud provisioning work starts.
- 2026-07-06: #151 added additive runner provisioning columns and constraints, expanded runner kind support to `digitalocean`, kept manual VPS endpoint compatibility constraints, added server-only DigitalOcean env/config validation, added a fake DigitalOcean provider, and added schema/provider/server-only tests.
- 2026-07-06: #151 maintainer review requested a compiler-enforced server-only boundary; token-bearing provider modules now import Next's `server-only` package, and Vitest aliases that package to an empty test helper for server-unit tests only.
- 2026-07-06: #152 added `runner_provisioning_events`, the `POST /api/runners` backend route, the DigitalOcean provisioning service/API provider, duplicate-submit handling, safe provider-failure state, and focused secret-safety tests for route and job behavior.
- 2026-07-06: #153 added server-generated cloud-init bootstrap content that installs Docker, prepares the runner service, runs a runner bootstrap command, and starts `runner:service`; added safe bootstrap redaction helpers; reused the existing one-time registration-token exchange and heartbeat credential lifecycle for cloud runners; and recorded `bootstrapping`, registration-complete, and first-heartbeat-ready provisioning events.
- 2026-07-06: #154 added a Create Runner action in Settings, dashboard/settings cloud provisioning panels, online readiness rendering from persisted runner status/heartbeat state, redacted failure guidance, focused unit coverage against the merged #152 route contract, and browser smoke coverage.
- 2026-07-06: #155 broadened assigned-runner persistence, status summaries, and lifecycle adapter selection to accept online `digitalocean` runners with endpoints; added failed-provision cleanup for owned DigitalOcean Droplets after post-create failures; added explicit manual cleanup instructions when automatic cleanup cannot be confirmed; and documented the required opt-in real-Droplet pre-beta smoke checklist.

### Validation Evidence

- 2026-07-06 #155:
  - `bun install --frozen-lockfile`: pass; installed committed dependencies in the fresh issue worktree after the first focused test attempt failed before Vitest started with `vitest: command not found`.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism tests/unit/runner-provisioning.test.ts tests/unit/create-agent-db.test.ts tests/unit/manual-runner-status.test.ts tests/unit/root-page.test.tsx tests/unit/cloud-runner-provisioning.test.ts tests/unit/cloud-runner-route.test.ts tests/unit/runner-registration.test.ts tests/unit/runner-heartbeat.test.ts`: pass; 8 files and 170 tests covered post-create Droplet cleanup/manual-cleanup paths, cloud-runner assignment through the lifecycle adapter, assigned-runner status/UI safety, provisioning UI DTOs, route behavior, registration, and heartbeat readiness.
  - `bun run format`: pass; Biome found no formatting changes to apply.
  - `bun run format:check`: pass; Biome checked 134 files with no fixes applied.
  - `bun run lint`: pass; Biome checked 134 files with no fixes applied.
  - `bun run typecheck`: pass; `tsc --noEmit` completed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: pass; Next.js production build completed and listed `/api/runners`.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:migrate`: pass; migrations applied successfully against the shared local database with existing `drizzle` schema/relation notices only.
  - `PORT=3105 PLAYWRIGHT_BASE_URL=http://localhost:3105 DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3105 bun run test:e2e -- --project=chromium-desktop --grep "cloud runner create action"`: pass; focused browser smoke clicked Create Runner, verified persisted safe provisioning progress/failure/online states, and confirmed state survived reload on an isolated dev-server port.
  - First `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism`: failed in `tests/unit/agent-logs-route.test.ts` because the test's hoisted mock for `manual-runner-persistence` hid constants that lifecycle now reads at module load. The mock was updated to expose `MANUAL_RUNNER_KIND` and `ACTIVE_RUNNER_STATUS`.
  - Final `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism`: pass; 43 files and 344 tests passed.
  - Final `git diff --check`: pass; no whitespace errors.
  - Real DigitalOcean smoke: not run in this local issue branch. `docs/MILESTONE_13_CLOUD_PROVISIONING_SMOKE.md` records the required opt-in pre-beta real small-Droplet checklist with server-side env vars, expected evidence, and cleanup steps.

- 2026-07-06 #154:
  - `bun install --frozen-lockfile`: pass; installed dependencies in the fresh worktree after the first `bun run format` attempt failed with `biome: command not found`.
  - `bun run format`: pass; Biome formatted the touched app, server, CSS, and test files.
  - `bun run test -- tests/unit/cloud-runner-provisioning.test.ts tests/unit/cloud-runner-route.test.ts tests/unit/root-page.test.tsx`: pass; 3 files and 33 tests passed, including safe DTO/route/page assertions that omit registration tokens, runner credentials, provider token names, credential hashes, and secret-looking failure details.
  - `bun run format:check`: pass; Biome checked 126 files with no fixes applied.
  - `bun run lint`: pass; Biome checked 126 files with no fixes applied.
  - `bun run typecheck`: pass; `tsc --noEmit` completed.
  - `PORT=3104 DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3104 bun run test:e2e -- --project=chromium-desktop --grep "cloud runner create action"`: pass; focused browser smoke clicked Create Runner, verified pending provisioning, seeded failed and online states, checked safe failure copy, confirmed online heartbeat readiness, and confirmed state persisted after reload. The first attempt on port 3000 failed with `POST /api/agents` returning 404 because Playwright reused an existing non-branch server; isolated port 3104 fixed the environment issue.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism`: failed in existing DB-backed suites with shared-table reset symptoms unrelated to the #154 UI path: runner heartbeat and manual runner adapter tests observed missing FK rows, empty log reads, and a deadlock while truncating shared tables. Focused #154 tests, format/lint/typecheck, build, E2E smoke, and `git diff --check` passed.
  - `bun run build`: pass; Next.js production build completed and listed `/api/runners`.
  - `git diff --check`: pass; no whitespace errors.

- 2026-07-06 #151:
  - `bun run format:check`: pass; Biome checked 121 files with no fixes applied.
  - `bun run lint`: pass; Biome lint checked 121 files with no fixes applied.
  - `bun run typecheck`: pass; `tsc --noEmit` completed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:migrate`: pass; migration `0010_quick_warbird.sql` applied successfully to the shared local database with existing `drizzle` schema/relation notices only.
  - Initial existing-runner compatibility test before migration: failed with missing `runners.provider` column, confirming the local database needed the new migration before exercising the branch.
  - Initial post-migration compatibility rerun exposed a brittle heartbeat test fixture: seeded runner `updated_at` used database real time while the test simulated `2026-07-05T08:02:00.000Z`, so the production `updated_at < now` safeguard correctly blocked moving rows backward in time. The test helper now seeds deterministic pre-cutoff timestamps.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism tests/unit/runner-registration.test.ts tests/unit/runner-heartbeat.test.ts tests/unit/manual-runner-status.test.ts tests/unit/runner-registration-routes.test.ts tests/unit/runner-heartbeat-route.test.ts`: pass; 5 files and 34 tests passed for existing manual registration, heartbeat, status, and route compatibility.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- tests/unit/agent-schema.test.ts tests/unit/digitalocean-provider.test.ts tests/unit/server-env.test.ts`: pass; 3 files and 26 tests passed for schema/migration coverage, fake DigitalOcean provider behavior, and server-only provider config/client import guards.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism`: pass; 37 files and 310 tests passed against the migrated local database.
  - After maintainer review fix: `bun run format:check`, `bun run lint`, `bun run typecheck`, and `git diff --check` pass; focused schema/provider/server-env tests pass (3 files and 26 tests); existing manual runner compatibility tests pass (5 files and 34 tests); `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build` passes; serialized full unit suite passes (37 files and 310 tests).
  - Full `bun run verify` was not run before checker handoff because #151 currently has focused schema/provider/config/compatibility coverage plus package gates, and this repo has known default-parallel shared-DB Vitest isolation risk recorded above.

- 2026-07-06 #152:
  - `bun install --frozen-lockfile`: pass; installed committed dependencies because this fresh worktree had no `node_modules`.
  - `bun run db:generate`: pass; generated `drizzle/0011_blushing_brother_voodoo.sql` and matching snapshot for `runner_provisioning_events`.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:migrate`: pass; applied migrations to the shared local database with existing Drizzle schema/relation notices only.
  - Initial focused test run without `--no-file-parallelism`: failed from shared-DB truncation races between DB-backed runner suites; serialized rerun passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism tests/unit/runner-provisioning.test.ts tests/unit/runner-provisioning-route.test.ts tests/unit/agent-schema.test.ts tests/unit/digitalocean-provider.test.ts tests/unit/runner-registration.test.ts tests/unit/runner-registration-routes.test.ts`: pass; 6 files and 44 tests passed.
  - `bun run format:check`: pass; Biome checked 125 files with no fixes applied.
  - `bun run lint`: pass; Biome lint checked 125 files with no fixes applied.
  - `bun run typecheck`: pass; `tsc --noEmit` completed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism tests/unit/runner-provisioning.test.ts tests/unit/runner-provisioning-route.test.ts tests/unit/runner-registration.test.ts tests/unit/runner-registration-routes.test.ts tests/unit/runner-heartbeat.test.ts tests/unit/runner-heartbeat-route.test.ts tests/unit/runner-credential-lifecycle.test.ts tests/unit/runner-credential-lifecycle-routes.test.ts tests/unit/manual-runner-status.test.ts tests/unit/digitalocean-provider.test.ts tests/unit/server-env.test.ts tests/unit/agent-schema.test.ts`: pass; 12 files and 80 tests passed.
  - `git diff --check`: pass; no whitespace errors.
  - Full `bun run verify` and E2E were not run before checker handoff because #152 is a backend route/service slice with focused route/service/schema/provider coverage, broader runner unit coverage, and package gates; the repo has known default-parallel shared-DB Vitest isolation risk recorded above.

- 2026-07-06 #153:
  - `bun install --frozen-lockfile`: pass; restored local package binaries from the committed lockfile.
  - `bunx drizzle-kit generate --name runner_provisioning_events`: pass after install; generated the provisioning-event table migration. The SQL hash matches the parallel #152 event-table migration, so this branch uses the same `0011_blushing_brother_voodoo` tag to avoid duplicate shared-DB migration application.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:migrate`: pass; existing `drizzle` schema notices only.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism tests/unit/cloud-runner-bootstrap.test.ts tests/unit/runner-service-bootstrap.test.ts tests/unit/runner-registration.test.ts tests/unit/runner-heartbeat.test.ts tests/unit/runner-registration-routes.test.ts tests/unit/runner-heartbeat-route.test.ts tests/unit/agent-schema.test.ts`: pass; 7 files and 59 tests covered bootstrap content, redaction, runner-side registration/heartbeat calls, cloud registration exchange, heartbeat readiness, routes, and schema/migration shape.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism tests/unit/runner-auth-secrets.test.ts tests/unit/runner-registration.test.ts tests/unit/runner-registration-routes.test.ts tests/unit/runner-heartbeat.test.ts tests/unit/runner-heartbeat-route.test.ts tests/unit/runner-credential-lifecycle.test.ts tests/unit/runner-credential-lifecycle-routes.test.ts tests/unit/runner-service.test.ts tests/unit/runner-service-bootstrap.test.ts tests/unit/cloud-runner-bootstrap.test.ts tests/unit/digitalocean-provider.test.ts tests/unit/manual-runner-status.test.ts tests/unit/manual-runner-adapter.test.ts`: pass; 13 files and 67 broader runner tests passed.
  - `bun run format:check`: pass; Biome checked 126 files with no fixes applied.
  - `bun run lint`: pass; Biome lint checked 126 files with no fixes applied.
  - `bun run typecheck`: pass; `tsc --noEmit` completed.
  - `git diff --check`: pass; no whitespace errors.
  - Optional `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism`: failed outside the required #153 gate with shared-DB/reset symptoms and older `create-agent-db` route failures; the focused acceptance and broader runner slices above pass when run serially and are the checker handoff evidence for this issue.

- 2026-07-06 #150:
  - `gh issue view 150 --repo ametel01/agentbay --json number,title,body,state,url`: pass; issue is open and maps Milestone 13 tracking to `docs/MILESTONES.md` plus PLAN Step 0.
  - `test -f PLAN.md`: not present in this worktree; #150 issue body and `docs/MILESTONES.md` are recorded above as the active contract.
  - `rg -n "Keep a Changelog|## \\[Unreleased\\]|Semantic Versioning" CHANGELOG.md`: pass; required changelog structure is present.
  - Initial `bun run format:check`: environment failure; `biome` binary was unavailable in the fresh worktree (`/opt/homebrew/bin/bash: line 1: biome: command not found`).
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed `bun.lock` without changing tracked files.
  - `bun run format:check`: pass; Biome checked 117 files with no fixes applied.
  - `git diff --check`: pass; no whitespace errors.
  - `git status --short --branch --untracked-files=all`: branch `codex/issue-150-m13-tracking` is based on `origin/main` with only `PROGRESS.md` modified.

## Milestone 14 One User, Multiple Agents

- Status: #161 final acceptance evidence is in progress on `codex/issue-161-m14-acceptance`.
- Source plan:
  - `docs/MILESTONES.md` Milestone 14: One User, Multiple Agents.
  - GitHub issue #156: Prepare Milestone 14 tracking and baseline gates.
  - `PLAN.md` is absent in this worktree; the published #156 issue body and `docs/MILESTONES.md` are the active Step 0 contract.
- Current branch: `codex/issue-161-m14-acceptance`.

### Issue Checklist

- [x] #156 Prepare Milestone 14 tracking and baseline gates. Status: merged in PR #175.
- [x] #157 Add runner capacity snapshots and placement contract. Status: merged in PR #176.
- [x] #158 Enforce capacity and plan limits on create and start. Status: merged in PR #177.
- [x] #159 Harden per-agent runtime and log isolation. Status: merged in PR #178.
- [x] #160 Show runner capacity in the operations UI. Status: merged in PR #179.
- [ ] #161 Complete multi-agent runner acceptance evidence. Status: implementation and validation in progress.

### Current Status

- Milestone 14 goal from `docs/MILESTONES.md`: a user can run multiple agents on one runner with separated status, logs, and capacity.
- Milestone 14 acceptance criteria: user can create three agents and start all on one runner; stopping one agent does not affect the others; logs stay separated by agent; runner capacity is visible and updates; capacity and plan limits block excess starts or creates.
- Milestone 14 test expectations from `docs/MILESTONES.md`: placement tests for capacity available and unavailable, concurrency tests for simultaneous start requests, integration tests with multiple agents and separated logs, and UI tests for capacity display.
- #156 is tracking-only. It initializes the Milestone 14 progress record, records baseline gate expectations, verifies changelog structure, and intentionally leaves `CHANGELOG.md` unchanged because no functional user/operator-visible behavior ships in this issue.
- #157 adds a shared server-side runner placement contract that selects an eligible online runner for the development user, normalizes latest heartbeat metrics into stable snake_case capacity fields, combines heartbeat-reported running-agent count with assigned running agents from the database, and returns safe structured blockers for no runner, plan limit, and runner capacity cases.
- #158 consumes the placement contract from agent create and lifecycle start: new agents persist an eligible online runner assignment when placement succeeds, create/start return safe plan-limit and runner-capacity blockers, and online runner starts reserve capacity under a PostgreSQL advisory lock before invoking the runner adapter so concurrent starts cannot overbook the final slot.
- #159 hardens Docker runner isolation by deriving a unique container-side config path per agent, while preserving the configured host config file; focused regressions prove three agents on one runner get distinct container names, labels, workspace paths, config paths, and bind mount strings, and stopping one Docker-backed agent does not mutate a sibling agent's status or runtime row.
- #160 adds runner capacity rows to dashboard runner health, settings registered runners, and assigned-runner detail. These surfaces render compact running/max agent capacity, CPU/memory/disk metrics when reported, clean `Not reported` fallbacks when unknown, and runner-capacity blocker state without exposing raw heartbeat metadata keys or secrets.
- #161 adds a focused database acceptance regression proving three agents can be created, assigned to one online runner, and started successfully before a fourth create is rejected by runner capacity.
- Final Milestone 14 acceptance map:
  - User can create three agents and start all on one runner: #161 `create-agent-db` regression creates three agents, starts all through the assigned online runner adapter, and verifies every persisted agent is `running` with the same `runner_id`.
  - Stopping one agent does not affect the others: #159 Docker lifecycle regression proves stopping one Docker-backed agent leaves the sibling agent status and runtime row unchanged; the real-Docker acceptance smoke also verifies the sibling selected container remains running after stop/restart/delete paths.
  - Logs stay separated by agent: #159 focused unit coverage proves Docker runtime metadata/log scoping and dashboard latest log identity; the existing real-Docker smoke verifies selected-agent log responses contain only that agent id and reject sibling ids.
  - Runner capacity is visible and updates: #160 status summaries combine normalized heartbeat capacity with persisted assigned running-agent counts, and dashboard/settings/assigned-runner unit plus Playwright coverage assert `3 / 5 agents running` and resource metrics.
  - Capacity and plan limits block excess starts or creates: #158 create/start placement tests cover plan-limit and runner-capacity create/start blockers, concurrent final-slot protection, and safe route responses; #161 adds the three-running-agents fourth-create capacity rejection.
  - Test categories from `docs/MILESTONES.md`: #157 placement tests cover capacity available/unavailable; #158 covers concurrent start protection; #159 and #161 cover multi-agent integration and separated logs/status; #160 covers UI capacity display.
- `CHANGELOG.md` has the Keep a Changelog 1.0.0 framing and an `## [Unreleased]` section. Agents should keep that structure and add changelog bullets only for shipped functional user/operator-visible changes.

### Baseline Gate Expectations

- Default local database for verify, DB-backed unit tests, migrations, health checks, and default E2E: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay`.
- Default local app URL for verify and E2E: `NEXT_PUBLIC_APP_URL=http://localhost:3000`.
- Default E2E server URL: `PORT=3000` and `PLAYWRIGHT_BASE_URL=http://localhost:3000` unless an issue uses an isolated port; when an isolated E2E port is used, set `PORT`, `PLAYWRIGHT_BASE_URL`, and `NEXT_PUBLIC_APP_URL` to the same localhost port.
- Canonical aggregate gate: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run verify`.
- Required #156 baseline command: `bun run format:check`.
- Known repo caveats:
  - Fresh worktrees may need `bun install --frozen-lockfile` before package scripts are available.
  - Default-parallel DB-backed Vitest inside `bun run verify` has previously failed from shared-DB isolation races. If this repeats, rerun the relevant branch command and prove whether the same failure reproduces on current `main` before calling it a branch regression.
  - As recorded during #155 checker review, `bun run db:health` currently fails under plain Bun on the existing baseline because the `server-only` import guard trips through `src/server/env.ts`; treat this as separate baseline follow-up unless a Milestone 14 issue changes that path.

### Update Rules

- Every Milestone 14 implementation issue must update this section after validation with the issue number, changed behavior, commands run, pass/fail result, skipped checks with reasons, and remaining risks.
- Preserve Milestone 15 as future scope; do not add backup, restore, billing, production deploy, unrelated provider work, or non-Milestone-14 UI changes while executing Milestone 14.
- Keep runner credentials, registration tokens, cloud provider secrets, bearer tokens, production URLs, and endpoint credentials out of committed docs, UI output, tests, logs, and status messages.
- Update `CHANGELOG.md` only for shipped functional user/operator-visible changes. Do not add changelog entries for tracking-only, validation-only, test-only, or documentation-only work.

### Update Log

- 2026-07-06: #156 initialized Milestone 14 tracking from `docs/MILESTONES.md` and the published #156 issue body; noted that `PLAN.md` is absent in this worktree and the published issue body plus milestone document are the active Step 0 contract.
- 2026-07-06: #156 confirmed `CHANGELOG.md` has Keep a Changelog 1.0.0 framing and `## [Unreleased]`; `CHANGELOG.md` is intentionally unchanged for #156 because this issue creates tracking only and ships no functional product behavior.
- 2026-07-06: #156 recorded baseline gate expectations for `bun run verify`, `bun run test:e2e`, the local Postgres `DATABASE_URL`, and `NEXT_PUBLIC_APP_URL` before multi-agent runner work starts.
- 2026-07-06: #157 added `src/server/runners/runner-placement.ts` with the shared capacity snapshot shape, metric normalization, capacity availability helper, and development-user placement selector; added focused tests for capacity available, capacity unavailable, no online runner, plan limit, and snake_case metric normalization.
- 2026-07-06: #158 wired placement into `POST /api/agents` creation and lifecycle start, added transaction-aware runner placement reuse, added runner-capacity advisory locking for start reservations, preserved no-online-runner local fallback behavior, and added safe route responses for plan and capacity blockers.
- 2026-07-06: #159 changed Docker run planning so `AGENTBAY_CONFIG_PATH` and the config bind-mount target include the agent id, added a three-agent run-plan isolation regression, and added a Docker stop regression that proves sibling status/runtime rows are untouched.
- 2026-07-06: #160 exposed runner capacity in dashboard, settings, and assigned-runner surfaces, including compact running/max agent counts, resource metrics when available, unknown-metric fallbacks, and runner capacity blocker copy.
- 2026-07-06: #161 added the final Milestone 14 acceptance map and a three-agent one-runner start regression that blocks a fourth create at runner capacity.

### Validation Evidence

- 2026-07-06 #156:
  - `gh issue view 156 --repo ametel01/agentbay --json number,title,body,state,url,labels`: pass; issue is open and maps Milestone 14 tracking to `docs/MILESTONES.md` plus PLAN Step 0.
  - `test -f PLAN.md`: not present in this worktree; #156 issue body and `docs/MILESTONES.md` are recorded above as the active contract.
  - `rg -n "Keep a Changelog|## \\[Unreleased\\]|Semantic Versioning" CHANGELOG.md`: pass; required changelog structure is present.
  - Initial `bun run format:check`: environment failure; `biome` binary was unavailable in the fresh worktree (`/opt/homebrew/bin/bash: line 1: biome: command not found`).
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed `bun.lock` without changing tracked files.
  - `bun run format:check`: pass; Biome checked 134 files with no fixes applied.
  - `git diff --check`: pass; no whitespace errors.
  - `git status --short --branch --untracked-files=all`: branch `codex/issue-156-m14-tracking` is based on `origin/main` with only `PROGRESS.md` modified.

- 2026-07-06 #157:
  - `gh issue view 157 --repo ametel01/agentbay --json number,title,body,state,url,labels`: pass; issue is open and maps Milestone 14 placement/capacity contract work to `docs/MILESTONES.md` plus PLAN Step 1.
  - `bun install --frozen-lockfile`: pass; installed committed dependencies in the fresh issue worktree after the first focused test attempt failed before Vitest started with `vitest: command not found`.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism tests/unit/runner-placement.test.ts`: pass; 1 file and 5 tests covered capacity available, capacity unavailable, no online runner, plan-limit rejection, and normalized shared capacity fields.
  - First `bun run typecheck`: failed because the `runner_capacity_reached` return type could include an undefined first candidate; fixed with an explicit first-candidate guard.
  - First `bun run lint`: warning for an unused test import; removed it.
  - Final `bun run typecheck`: pass; `tsc --noEmit` completed.
  - Final `bun run lint`: pass; Biome checked 136 files with no fixes applied.
  - `bun run format:check`: pass; Biome checked 136 files with no fixes applied.
  - `git diff --check`: pass; no whitespace errors.

- 2026-07-06 #158:
  - `gh issue view 158 --json title,body,labels,state`: pass; issue is open and maps Milestone 14 enforcement to PLAN Step 2 with create/start placement consumption, safe blockers, and concurrent-start protection.
  - Initial `bun run typecheck`: environment failure before install; `tsc` was unavailable in the fresh issue worktree.
  - `bun install --frozen-lockfile`: pass; installed committed dependencies from `bun.lock`.
  - `bun run format`: pass; Biome formatted the touched app, server, and test files.
  - `bun run typecheck`: pass; `tsc --noEmit` completed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism tests/unit/runner-placement.test.ts tests/unit/create-agent-db.test.ts tests/unit/create-agent-route.test.ts tests/unit/start-agent-route.test.ts`: pass; 4 files and 131 tests covered placement, create assignment, safe create blockers, start reservation, start capacity blocking before adapter launch, concurrent final-slot starts, and route-safe 409 responses.
  - `bun run format:check`: pass; Biome checked 136 files with no fixes applied.
  - Initial `bun run lint`: warning for a type-only test import; fixed by making `AgentCreateBlockedError` a type import.
  - `bun run lint`: pass; Biome checked 136 files with no fixes applied.
  - `git diff --check`: pass; no whitespace errors.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: pass; Next.js production build completed and listed `/api/agents`, `/api/agents/:agentId/actions/start`, runner APIs, dashboard, agents, and settings routes.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism`: pass; 44 files and 359 tests passed.
  - Checker fix cycle 2: checker found that assigned online-runner starts did not forward `planMaxAgents` into the placement check, while unassigned starts did. The assigned-runner branch now forwards the plan limit and preserves `plan_limit_reached` instead of collapsing it to capacity.
  - Fix cycle 2 validation: `bun run format`, `bun run typecheck`, `bun run format:check`, `bun run lint`, and `git diff --check` pass. Focused suite `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism tests/unit/runner-placement.test.ts tests/unit/create-agent-db.test.ts tests/unit/create-agent-route.test.ts tests/unit/start-agent-route.test.ts` passes with 4 files and 132 tests, including an assigned-runner start plan-limit regression that proves no runner adapter launches.

- 2026-07-06 #159:
  - `gh issue view 159 --repo ametel01/agentbay --json number,title,state,url,body,labels`: pass; issue is open and maps Milestone 14 per-agent runtime/log isolation to Docker identifiers, mounts/config paths, sibling status safety, detail log scoping, and dashboard latest log identity.
  - Initial `bun run format` and `bun run typecheck`: environment failure before install; `biome` and `tsc` were unavailable in the fresh issue worktree.
  - `bun install --frozen-lockfile`: pass; installed committed dependencies from `bun.lock`.
  - `bun run format`: pass; Biome formatted the touched server and test files.
  - `bun run typecheck`: pass; `tsc --noEmit` completed after replacing unsupported `toHaveSize` set matchers with explicit `.size` assertions.
  - First focused Docker isolation suite failed because the new stop regression did not account for the existing post-stop Docker log pull. The test stub was updated to expect the owning container log call.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism tests/unit/docker-runner-adapter.test.ts tests/unit/create-agent-db.test.ts`: pass; 2 files and 120 tests covered Docker run-plan uniqueness, Docker runtime metadata/log scoping, lifecycle stop sibling isolation, cleanup/reconcile isolation, dashboard latest log identity, and existing agent detail log scoping.
  - `bun run format:check`: pass; Biome checked 136 files with no fixes applied.
  - `bun run lint`: pass; Biome checked 136 files with no fixes applied.
  - `git diff --check`: pass; no whitespace errors.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: pass; Next.js production build completed and listed the existing app/API routes. The generated `next-env.d.ts` route-reference churn from build was restored before commit.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism`: pass; 44 files and 362 tests passed.

- 2026-07-06 #160:
  - `gh issue view 160 --repo ametel01/agentbay --json number,title,state,url,body,labels`: pass; issue mapped Milestone 14 runner capacity UI to compact running/max agents, CPU/memory/disk display, graceful unknown metrics, blocker copy, and focused UI/browser coverage.
  - `bun install`: pass; installed committed dependencies in the fresh issue worktree.
  - `bun run test tests/unit/manual-runner-status.test.ts`: pass; 1 file and 6 tests covered capacity summaries, assigned lifecycle counts, safe metadata omission, and settings management DTO shape.
  - `bun run test tests/unit/root-page.test.tsx`: pass; 1 file and 28 tests covered dashboard/settings/assigned capacity rendering and unknown metric fallbacks.
  - `bun run format:check`: pass; Biome checked 137 files with no fixes applied.
  - `bun run lint`: pass; Biome checked 137 files with no fixes applied.
  - `bun run typecheck`: pass; `tsc --noEmit` completed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test tests/unit/runner-placement.test.ts`: pass; 1 file and 5 tests covered the shared capacity placement contract.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test tests/unit/create-agent-db.test.ts -t "assigns an active manual runner to an active agent and reads it by development user"`: pass; 1 focused DB test covered assigned runner reads after lifecycle placement.
  - `bun run test:e2e -- --grep "manual runner status, alerts, and remote logs stay visible and safe"`: pass; Chromium desktop and mobile covered dashboard/settings/assigned capacity display, resource metrics, capacity blocker copy, and safe omission of secrets/raw metric keys.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: pass; Next.js production build completed.
  - `git diff --check`: pass; no whitespace errors.
  - Unscoped `bun run test` without env failed immediately because DB-backed tests require `DATABASE_URL` and `NEXT_PUBLIC_APP_URL`. An env-backed broad parallel `bun run test` later failed with shared Postgres truncate deadlocks/hook timeouts/FK fallout when DB-heavy suites ran in parallel; targeted affected DB suites passed in isolation.

- 2026-07-06 #161:
  - `gh issue view 161 --repo ametel01/agentbay --json number,title,state,url,body,labels`: pass; issue maps Milestone 14 final acceptance to three agents on one runner, isolated status/logs, capacity display updates, capacity/plan-limit blockers, and final progress evidence.
  - `bun install --frozen-lockfile`: pass; installed committed dependencies in the fresh issue worktree.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism tests/unit/create-agent-db.test.ts -t "starts three agents on one runner and blocks a fourth create at capacity"`: pass; 1 focused test created three agents, started all on the same online runner, verified persisted running status/runner assignment, and rejected a fourth create with `runner_capacity_reached`.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism tests/unit/runner-placement.test.ts tests/unit/docker-runner-adapter.test.ts tests/unit/manual-runner-status.test.ts tests/unit/root-page.test.tsx`: pass; 4 files and 43 tests covered placement, Docker isolation, runner status summaries, and runner capacity UI rendering.
  - `bun run format:check`: pass; Biome checked 137 files with no fixes applied.
  - `bun run lint`: pass; Biome checked 137 files with no fixes applied.
  - `bun run typecheck`: pass after simplifying the new test assertion to avoid sorting nullable runner ids; `tsc --noEmit` completed.
  - `git diff --check`: pass; no whitespace errors.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism`: pass; 44 files and 363 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: pass; Next.js production build completed and listed the expected app/API routes. The generated `next-env.d.ts` route-reference churn from build was not kept in the diff.
  - `PORT=3161 DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3161 bun run test:e2e -- --project=chromium-desktop --grep "manual runner status, alerts, and remote logs stay visible and safe"`: pass; 1 Chromium desktop smoke covered capacity display/resource metrics and safe runner surfaces. The run emitted the existing PostgreSQL advisory-unlock warning from shared test cleanup, but the test passed.
  - `PORT=3162 DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3162 bun run test:e2e -- tests/e2e/root-route.spec.ts --project=chromium-desktop --grep "Docker runner final acceptance" --workers=1`: pass; 1 Chromium desktop smoke covered selected Docker container isolation, restart/stop/delete sibling safety, scoped logs, crash reconciliation, and fail-closed cleanup.
  - `CHANGELOG.md` is intentionally unchanged for #161 because this issue adds final acceptance evidence and regression coverage, not a new user/operator-visible product behavior beyond the already merged #157-#160 slices.

## Milestone 15 Backups and Restore

- Status: #168 final acceptance/security evidence is in progress on `codex/issue-168-backup-restore-evidence`.
- Source plan:
  - `docs/MILESTONES.md` Milestone 15: Backups and Restore.
  - GitHub issue #162: Prepare Milestone 15 tracking and baseline gates.
  - GitHub issue #163: Add backup persistence, manifest, and secret policy.
  - GitHub issue #164: Add S3-compatible backup object storage boundary.
  - GitHub issue #165: Implement manual agent backup creation.
  - GitHub issue #166: Restore backups into new agents.
  - GitHub issue #167: Add backup and restore controls to the agent UI.
  - GitHub issue #168: Complete backup restore acceptance and security evidence.
  - `PLAN.md` is absent in this worktree; the published #162-#168 issue bodies and `docs/MILESTONES.md` are the active Milestone 15 contract.
- Current branch: `codex/issue-168-backup-restore-evidence`.

### Issue Checklist

- [x] #162 Prepare Milestone 15 tracking and baseline gates. Status: merged in PR #181.
- [x] #163 Add backup persistence, manifest, and secret policy. Status: merged in PR #182.
- [x] #164 Add S3-compatible backup object storage boundary. Status: merged in PR #183.
- [x] #165 Implement manual agent backup creation. Status: merged in PR #184.
- [x] #166 Restore backups into new agents. Status: merged in PR #185.
- [x] #167 Add backup and restore controls to the agent UI. Status: merged in PR #186.
- [ ] #168 Complete backup restore acceptance and security evidence. Status: implementation and validation in progress.
- Later Milestone 15 issue agents must append validation evidence here after their implementation slices merge.

### Current Status

- Milestone 15 goal from `docs/MILESTONES.md`: users can recover agent config, memory, and important metadata.
- Milestone 15 acceptance criteria: user can create a manual backup; backup status is visible; user can restore an agent from backup; restored agent has expected config and metadata; backup and restore events appear in the timeline.
- Milestone 15 test expectations from `docs/MILESTONES.md`: backup manifest schema tests, object storage fake tests for upload and download, restore test creating a new agent from backup, and a security test ensuring raw secrets are not written into backup manifests.
- #162 is tracking-only. It initializes the Milestone 15 progress record, records baseline gate expectations, verifies changelog structure, and intentionally leaves `CHANGELOG.md` unchanged because no functional user/operator-visible behavior ships in this issue.
- Backup implementation should start with manual backup and restore. Scheduled backups remain later scope.
- Backup storage should use an S3-compatible object storage boundary, such as DigitalOcean Spaces or AWS S3, without committing provider credentials or production storage URIs.
- The backup manifest should include agent metadata, config, template snapshot, system prompt, skills folder metadata, memory files, and logs metadata; high-volume logs are not required in full for the initial milestone.
- Sensitive backup payloads must be encrypted or excluded with secret references only. Raw secrets must not be written into backup manifests, docs, UI output, tests, logs, or status messages.
- Restore can initially create a new agent from backup to avoid overwriting a running agent.
- Backup and restore behavior should write `backup.created` and `backup.restored` events for timeline visibility.
- #163 adds the shared persistence and validation foundation for the downstream backup/restore slices:
  - `backups` stores `id`, `agent_id`, `runner_id`, `status`, `storage_uri`, `manifest_json`, `created_by`, `created_at`, and `restored_at`.
  - Backup statuses are `pending`, `uploading`, `ready`, `failed`, `restoring`, and `restored`.
  - Backup manifest validation covers agent metadata, config metadata, template snapshot, system prompt, skills file metadata, memory file metadata, and log metadata.
  - Raw secret-like manifest keys or values are rejected, while `config.secretReferences` allows safe `env`, `vault`, and `external` references.
- #164 adds the server-only object storage boundary for downstream backup/restore slices:
  - `BackupObjectStorage` supports `upload` and `download` through `FakeBackupObjectStorage` for deterministic no-network tests and `S3CompatibleBackupObjectStorage` for S3-compatible endpoints.
  - Backup storage URIs use `s3://<bucket>/<key>` and reject empty, absolute, traversal, control-character, or oversized artifact keys.
  - S3-compatible config validation reads only server-side `AGENTBAY_BACKUP_STORAGE_*` values, requires HTTPS for remote endpoints, rejects endpoint userinfo/query/fragment values, validates bucket and region shape, and keeps credentials out of shared/client env validation.
  - Upload/download failures map to safe `failed` status objects with generic messages that omit endpoints, buckets, access keys, and secret keys.
- #165 adds manual backup creation for existing active development-user agents:
  - `POST /api/agents/:agentId/backups` validates the selected agent ID and creates a manual backup through the server-only backup service.
  - Manual backup creation collects agent metadata, config, template snapshot, sanitized system prompt, skills metadata, memory metadata, and log metadata into the shared manifest format.
  - Backup artifacts upload through the `BackupObjectStorage` boundary; successful uploads mark the backup `ready`, persist `storage_uri`, and write one `backup.created` audit event.
  - Missing agents return `agent_not_found`, while storage or manifest failures leave a safe `failed` backup row without raw secrets or credential details.
- #166 adds restore creation for ready backups:
  - `POST /api/agents/:agentId/backups/:backupId/restore` validates the selected agent and backup IDs before invoking the server-only restore service.
  - Restore downloads the backup artifact through `BackupObjectStorage`, validates the manifest and template snapshot shape, and rejects raw secret-like text before creating an agent.
  - Successful restore creates a new stopped agent instead of overwriting the source, restores config/system prompt/template snapshot metadata, marks the backup `restored` with `restored_at`, and writes one `backup.restored` audit event on the restored agent.
  - Missing artifacts, invalid manifests, unsafe artifacts, missing storage config, or non-restorable backups return safe errors without exposing credentials or artifact contents.
- #167 adds backup controls to the agent detail operations UI:
  - Agent detail now loads a safe backup summary read model with backup ID, status, created time, restored time, and restore eligibility only.
  - The Backups panel lets users create a manual backup and restore a ready backup through the existing #165/#166 routes, then refreshes the persisted view.
  - Restore success can link to the newly restored agent, making the restored agent discoverable without rendering storage URIs, manifest JSON, secret references, or raw artifact internals.
- #168 completes final Milestone 15 acceptance/security evidence:
  - `tests/unit/backup-restore-acceptance.test.ts` exercises the real DB-backed manual backup and restore services with fake object storage in one flow, then verifies visible backup status, restored config/template metadata, `backup.created` and `backup.restored` timeline events, and raw-secret exclusion from manifests, stored artifacts, event/read-model surfaces, and backup log summaries.
  - `backup.created` event metadata now records only safe backup ID and status context, not backup storage URIs, so the activity feed can show backup timeline events without exposing artifact locations.
  - Existing route/UI tests continue to prove browser-visible create/restore responses and the agent detail backup controls omit storage URIs, manifest JSON, secret references, and raw artifact internals.
  - Validation: `bun install --frozen-lockfile` passed after the fresh worktree initially lacked package shims; `bun run format`; focused serialized backup/restore acceptance suite passed (7 files, 48 tests); `bun run format:check`; `bun run lint`; `bun run typecheck`; `git diff --check`; production `bun run build`; full serialized unit suite passed (52 files, 399 tests); focused Chromium backup-controls smoke passed on port 3168.
  - Default `bun run verify` remains intentionally skipped because its default parallel DB-backed Vitest step is the documented shared-table reset race; this branch instead records equivalent serialized unit, build, static gates, and focused browser evidence.
- `CHANGELOG.md` has the Keep a Changelog 1.0.0 framing and an `## [Unreleased]` section. Agents should keep that structure and add changelog bullets only for shipped functional user/operator-visible changes.

### Baseline Gate Expectations

- Default local database for verify, DB-backed unit tests, migrations, health checks, and default E2E: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay`.
- Default local app URL for verify and E2E: `NEXT_PUBLIC_APP_URL=http://localhost:3000`.
- Default E2E server URL: `PORT=3000` and `PLAYWRIGHT_BASE_URL=http://localhost:3000` unless an issue uses an isolated port; when an isolated E2E port is used, set `PORT`, `PLAYWRIGHT_BASE_URL`, and `NEXT_PUBLIC_APP_URL` to the same localhost port.
- Canonical aggregate gate: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run verify`.
- Required #162 baseline command: `bun run format:check`.
- Known repo caveats:
  - Fresh worktrees may need `bun install --frozen-lockfile` before package scripts are available.
  - Default-parallel DB-backed Vitest inside `bun run verify` has previously failed from shared-DB isolation races. If this repeats, rerun the relevant branch command and prove whether the same failure reproduces on current `main` before calling it a branch regression.
  - As recorded during #155 checker review, `bun run db:health` currently fails under plain Bun on the existing baseline because the `server-only` import guard trips through `src/server/env.ts`; treat this as separate baseline follow-up unless a Milestone 15 issue changes that path.

### Update Rules

- Every Milestone 15 implementation issue must update this section after validation with the issue number, changed behavior, commands run, pass/fail result, skipped checks with reasons, and remaining risks.
- Preserve Milestone 16 as future scope; do not add cost tracking, billing, production deploy, unrelated provider work, or non-Milestone-15 UI changes while executing Milestone 15.
- Keep S3-compatible storage credentials, cloud provider credentials, runner credentials, bearer tokens, production URLs, endpoint credentials, and backup payload secrets out of committed docs, UI output, tests, logs, and status messages.
- Update `CHANGELOG.md` only for shipped functional user/operator-visible changes. Do not add changelog entries for tracking-only, validation-only, test-only, or documentation-only work.

### Update Log

- 2026-07-06: #162 initialized Milestone 15 tracking from `docs/MILESTONES.md` and the published #162 issue body; noted that `PLAN.md` is absent in this worktree and the published issue body plus milestone document are the active Step 0 contract.
- 2026-07-06: #162 confirmed `CHANGELOG.md` has Keep a Changelog 1.0.0 framing and `## [Unreleased]`; `CHANGELOG.md` is intentionally unchanged for #162 because this issue creates tracking only and ships no functional product behavior.
- 2026-07-06: #162 recorded baseline gate expectations for `bun run verify`, `bun run test:e2e`, the local Postgres `DATABASE_URL`, and `NEXT_PUBLIC_APP_URL` before backup and restore work starts.
- 2026-07-06: #163 added the `backups` schema/migration, typed manifest validator, conservative backup status transition helper, raw-secret rejection policy, and focused schema/manifest tests.
- 2026-07-06: #164 added the server-only backup object storage boundary, deterministic fake storage, S3-compatible request signing/config validation, safe storage URI helper, safe upload/download failure mapping, and focused storage/security tests.
- 2026-07-06: #165 added manual backup creation with sanitized manifest assembly, backup artifact upload, ready/failed backup persistence, route handling, and `backup.created` audit events.
- 2026-07-06: #166 added backup restore creation with artifact download, manifest/template validation, unsafe artifact rejection, new stopped-agent creation, restored config/template metadata, restored backup status, and `backup.restored` audit events.
- 2026-07-06: #167 added a safe backup summary read model and agent-detail Backups panel with manual backup creation and ready-backup restore controls.

### Validation Evidence

- 2026-07-06 #162:
  - `gh issue view 162 --repo ametel01/agentbay --json number,title,state,url,body,labels`: pass; issue is open and maps Milestone 15 tracking to `docs/MILESTONES.md` plus PLAN Step 0.
  - `test -f PLAN.md`: not present in this worktree; #162 issue body and `docs/MILESTONES.md` are recorded above as the active contract.
  - `rg -n "Keep a Changelog|## \\[Unreleased\\]|Semantic Versioning" CHANGELOG.md`: pass; required changelog structure is present.
  - `bun install --frozen-lockfile`: pass; installed committed dependencies from `bun.lock` in the fresh issue worktree.
  - `bun run format:check`: pass; Biome checked 137 files with no fixes applied.
  - `git diff --check`: pass; no whitespace errors.
  - `git status --short --branch --untracked-files=all`: branch `codex/issue-162-m15-tracking` is based on `origin/main` with only `PROGRESS.md` modified.

- 2026-07-06 #163:
  - `gh issue view 163 --repo ametel01/agentbay --json number,title,state,url,body,labels`: pass; issue is open and maps Milestone 15 backup persistence, manifest validation, backup statuses, and raw-secret exclusion to PLAN Step 1.
  - `bun install --frozen-lockfile`: pass; installed committed dependencies from `bun.lock` in the fresh issue worktree.
  - `bun run db:generate`: pass; generated additive `drizzle/0012_curly_franklin_storm.sql` and metadata snapshot for the `backups` table.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:migrate`: pass; applied migrations successfully with existing Drizzle schema/table notices only.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism tests/unit/backup-manifest.test.ts tests/unit/agent-schema.test.ts`: pass; 2 files and 29 tests covered manifest validity, invalid required sections, raw-secret rejection, safe secret references, backup status transitions, schema shape, and migration contents.
  - Initial `bun run typecheck`: failed on strict `unknown` narrowing in `backup-manifest.ts`; fixed with explicit numeric guards and a typed status-transition include.
  - `bun run typecheck`: pass; `tsc --noEmit` completed.
  - Initial `bun run lint`: failed on expression-bodied `forEach` callbacks in `backup-manifest.ts`; fixed with block callbacks.
  - `bun run lint`: pass; Biome checked 139 files with no fixes applied.
  - `bun run format:check`: pass; Biome checked 139 files with no fixes applied.
  - `git diff --check`: pass; no whitespace errors.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: pass; Next.js production build completed. The generated `next-env.d.ts` route-reference churn from build was not kept in the diff.
  - `CHANGELOG.md` updated under `## [Unreleased]` because #163 ships the backup persistence and manifest-validation foundation for downstream Milestone 15 behavior.

- 2026-07-06 #164:
  - `gh issue view 164 --repo ametel01/agentbay --json number,title,state,url,body,labels`: pass; issue is open and maps Milestone 15 object storage boundary, fake storage tests, server-only S3-compatible config validation, credential secrecy, and safe failure mapping to PLAN Step 2.
  - Initial `bun run format`, focused test, and `bun run typecheck`: environment failures before dependency install because `biome`, `vitest`, and `tsc` were unavailable in the fresh issue worktree.
  - `bun install --frozen-lockfile`: pass; installed committed dependencies from `bun.lock`.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism tests/unit/backup-storage.test.ts tests/unit/server-env.test.ts`: pass; 2 files and 13 tests covered fake upload/download, missing artifact/invalid key failures, S3-compatible config validation, local HTTP exception, stubbed S3 upload/download without network calls, credential-free failure mapping, server-only import, and client-component exclusion checks.
  - Initial `bun run typecheck`: failed on strict `RequestInit.body` and fetch stub input typing; fixed by copying PUT bodies to `ArrayBuffer` and normalizing stub inputs to `Request`.
  - `bun run typecheck`: pass; `tsc --noEmit` completed.
  - Initial `bun run lint`: failed on a control-character regex in artifact-key validation; fixed by replacing it with an explicit character-code scan.
  - `bun run lint`: pass; Biome checked 141 files with no fixes applied.
  - `bun run format:check`: pass; Biome checked 141 files with no fixes applied.
  - `git diff --check`: pass; no whitespace errors.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: pass; Next.js production build completed. The generated `next-env.d.ts` route-reference churn from build was not kept in the diff.
  - `CHANGELOG.md` updated under `## [Unreleased]` because #164 ships the backup object-storage boundary for downstream Milestone 15 behavior.

- 2026-07-06 #165:
  - `gh issue view 165 --repo ametel01/agentbay --json number,title,state,url,body,labels`: pass; issue is open and maps Milestone 15 manual backup creation, sanitized manifest assembly, object-storage upload, backup status persistence, and `backup.created` events to PLAN Step 3.
  - `bun install`: pass; installed dependencies in the fresh issue worktree before package-script validation.
  - Initial `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay bunx vitest run tests/unit/create-agent-backup.test.ts tests/unit/agent-backups-route.test.ts`: failed because `NEXT_PUBLIC_APP_URL` is required by server env validation before DB connection setup. The route test file passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bunx vitest run tests/unit/create-agent-backup.test.ts tests/unit/agent-backups-route.test.ts`: pass; 2 files and 6 tests covered ready backup creation, missing agent handling, safe failed backup persistence after upload failure, route validation, route success, and safe route failure mapping.
  - `bun run format`: pass; formatted the new backup service and route test files.
  - `bun run format:check`: pass; Biome checked 145 files with no fixes applied.
  - `bun run lint`: pass; Biome checked 145 files with no fixes applied after removing one unused import.
  - `bun run typecheck`: pass; `tsc --noEmit` completed.
  - `git diff --check`: pass; no whitespace errors.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: pass; Next.js production build completed and listed `/api/agents/:agentId/backups`. The generated `next-env.d.ts` route-reference churn from build was not kept in the diff.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism`: pass; 48 files and 385 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run verify`: failed during default-parallel `bun run test` with documented shared-database reset races: 9 files failed with PostgreSQL deadlocks, hook timeouts, duplicate `app_metadata` keys, and FK fallout while unrelated DB suites truncated overlapping tables concurrently. The decomposed gates above and the full `--no-file-parallelism` unit suite passed.
  - Post-aggregate rerun `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bunx vitest run tests/unit/create-agent-backup.test.ts tests/unit/agent-backups-route.test.ts`: pass; 2 files and 6 tests passed after the failed parallel aggregate run.
  - `CHANGELOG.md` updated under `## [Unreleased]` because #165 ships user/operator-visible manual backup creation behavior.

- 2026-07-06 #166:
  - `gh issue view 166 --repo ametel01/agentbay --json number,title,state,url,body,labels`: pass; issue is open and maps Milestone 15 restore-to-new-agent, manifest validation, restored config/template/system prompt metadata, restored backup status, `backup.restored` event, and secret-safety tests to PLAN Step 4.
  - `bun install`: pass; installed dependencies in the fresh issue worktree before package-script validation.
  - Initial `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bunx vitest run tests/unit/restore-agent-backup.test.ts tests/unit/restore-backup-route.test.ts`: failed because the first unsafe-artifact test exposed a restore hardening gap for embedded raw secret-like text; restore now performs an additional recursive raw-secret scan before creating an agent.
  - Second focused restore suite run failed because the test seeded the persisted backup row with the unsafe artifact manifest; fixed the test to keep the persisted row safe and overwrite only the fake object-storage artifact.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bunx vitest run tests/unit/restore-agent-backup.test.ts tests/unit/restore-backup-route.test.ts`: pass; 2 files and 7 tests covered restore success, missing artifact failure, unsafe artifact failure, already-restoring backup rejection, `backup.restored` event creation, route validation, and non-restorable route conflict mapping.
  - Initial `bun run typecheck`: failed because restored template snapshots were not narrowed to supported template keys and `defaultSchedule: "Manual"`; fixed by validating snapshot shape with `isSupportedTemplateKey` and exact `Manual` schedule.
  - Initial `bun run lint`: warned on an unused import and transaction alias in `restore-backup.ts`; fixed.
  - `bun run format`: pass; formatted the new restore service and route test files.
  - `bun run format:check`: pass; Biome checked 149 files with no fixes applied.
  - `bun run lint`: pass; Biome checked 149 files with no fixes applied.
  - `bun run typecheck`: pass; `tsc --noEmit` completed.
  - `git diff --check`: pass; no whitespace errors.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: pass; Next.js production build completed and listed `/api/agents/:agentId/backups/:backupId/restore`. The generated `next-env.d.ts` route-reference churn from build was not kept in the diff.
  - Self-review found that already-`restoring` backups could be treated as restorable and concurrent restores could both pass the initial ready check; fixed by making only the call that atomically updates `ready` to `restoring` proceed, and added a regression for already-restoring backups.
  - Checker Ohm found that invalid restore schedule metadata could pass manifest validation, then either restore incorrectly or strand the backup in `restoring` after a DB config check failure. Fixed by validating restore config schedule shape before agent/config creation, and added a regression for `cron` without `scheduleCron`.
  - Combined focused DB test without serialization reproduced the known shared-table reset race; reran the same focused set with `--no-file-parallelism`.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism tests/unit/restore-agent-backup.test.ts tests/unit/restore-backup-route.test.ts tests/unit/backup-manifest.test.ts tests/unit/create-agent-backup.test.ts tests/unit/agent-backups-route.test.ts`: pass; 5 files and 19 tests passed.
  - Post-checker-fix `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: pass; Next.js production build completed and listed `/api/agents/:agentId/backups/:backupId/restore`. The generated `next-env.d.ts` route-reference churn from build was not kept in the diff.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism`: pass; 50 files and 393 tests passed.
  - Maintainer reviewer Descartes found that restore config validation still accepted non-empty invalid cron strings and invalid time zones that the normal config update path rejects. Fixed restore validation to mirror the existing five-field cron parser and `Intl.DateTimeFormat` timezone check before agent creation, and added regressions proving invalid cron/timezone artifacts fail safely without creating restored agents.
  - Post-maintainer-fix `bun run format`: pass; Biome found no formatting changes to apply.
  - Post-maintainer-fix `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism tests/unit/restore-agent-backup.test.ts tests/unit/restore-backup-route.test.ts tests/unit/backup-manifest.test.ts tests/unit/create-agent-backup.test.ts tests/unit/agent-backups-route.test.ts`: pass; 5 files and 20 tests passed.
  - Post-maintainer-fix `bun run format:check`, `bun run lint`, `bun run typecheck`, and `git diff --check`: pass.
  - Post-maintainer-fix `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: pass; Next.js production build completed and listed `/api/agents/:agentId/backups/:backupId/restore`. The generated `next-env.d.ts` route-reference churn from build was not kept in the diff.
  - Post-maintainer-fix `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism`: pass; 50 files and 394 tests passed.
  - `CHANGELOG.md` updated under `## [Unreleased]` because #166 ships user/operator-visible restore creation behavior.

- 2026-07-06 #167:
  - `gh issue view 167 --repo ametel01/agentbay --json number,title,state,url,body,labels`: pass; issue is open and maps Milestone 15 backup status UI, manual backup creation UI, restore UI, restored-agent discoverability, safe UI responses, and focused UI/browser smoke to PLAN Step 5.
  - `bun install --frozen-lockfile`: pass; installed committed dependencies in the fresh issue worktree after the first `bun run format` failed with `biome: command not found`.
  - Initial `bun run typecheck`: failed on exact optional property typing in the backup action success state, transaction-only `getDevelopmentUserId` usage in the backup summary read model, and a non-schema top-level `createdAt` in the test manifest fixture; fixed by conditionally omitting absent optional state, keeping the summary query in a transaction, and aligning the fixture with `BackupManifest`.
  - Initial `bun run lint`: warned on CSS selector ordering for `.backup-controls .form-message`; fixed by moving the more specific selector after the base `.form-message` rules.
  - `bun run format`: pass; formatted the new backup UI/read-model files.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism tests/unit/agent-backup-summaries.test.ts tests/unit/root-page.test.tsx`: pass; 2 files and 32 tests covered the safe backup summary read model, deleted-agent filtering, backup status rendering, restore control rendering, backup status failure fallback, and absence of storage URI/manifest/secret fields from UI output.
  - `bun run format:check`: pass; Biome checked 152 files with no fixes applied.
  - `bun run lint`: pass; Biome checked 152 files with no fixes applied.
  - `bun run typecheck`: pass; `tsc --noEmit` completed.
  - `git diff --check`: pass; no whitespace errors.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: pass; Next.js production build completed and listed both backup API routes. The generated `next-env.d.ts` route-reference churn from build was not kept in the diff.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism`: pass; 51 files and 398 tests passed.
  - `PORT=3167 PLAYWRIGHT_BASE_URL=http://localhost:3167 DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3167 bun run test:e2e -- --project=chromium-desktop --grep "backup status and runs backup restore controls"`: pass; focused smoke seeded a ready backup row, verified safe backup status rendering, intercepted the create/restore UI POSTs, verified the success messages and restored-agent link, and confirmed storage/artifact/secret strings were not rendered.
  - Checker Heisenberg found that DOM output was safe but the real browser-visible create/restore route responses still passed through service backup DTOs containing `storageUri`. Fixed both backup routes to sanitize client responses at the route boundary, omitting `storageUri`, `manifestJson`, storage credentials, and raw artifact internals; restore responses now expose only safe restored-agent link metadata.
  - Post-checker-fix `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism tests/unit/agent-backups-route.test.ts tests/unit/restore-backup-route.test.ts tests/unit/agent-backup-summaries.test.ts tests/unit/root-page.test.tsx`: pass; 4 files and 38 tests passed, including route regressions that service DTOs may contain `storageUri` but HTTP JSON responses do not.
  - Post-checker-fix `bun run format:check`, `bun run lint`, `bun run typecheck`, and `git diff --check`: pass.
  - Post-checker-fix `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: pass; Next.js production build completed and listed both backup API routes.
  - Post-checker-fix `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism`: pass; 51 files and 398 tests passed.
  - Post-checker-fix `PORT=3167 PLAYWRIGHT_BASE_URL=http://localhost:3167 DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3167 bun run test:e2e -- --project=chromium-desktop --grep "backup status and runs backup restore controls"`: pass.
  - `CHANGELOG.md` updated under `## [Unreleased]` because #167 ships user-visible backup status/create/restore controls.

## Milestone 12 Secure Runner Auth

- Status: Milestone 12 local automated acceptance is complete on `codex/issue-134-milestone-12-acceptance`; #126 remains separately external-blocked for Milestone 11 hosted-dashboard/manual-VPS smoke.
- Source plan:
  - `docs/MILESTONES.md` Milestone 12: Secure Runner Auth.
  - `docs/PRD.md` runner-auth product/testing decisions.
  - `docs/conversation_dump.md` Milestone 12 secure runner auth outline.
  - GitHub issues #127-#134 and GitHub milestone "Milestone 12: Secure Runner Auth".
- Current branch: `codex/issue-134-milestone-12-acceptance`.
- Next step: open #134 PR for checker/reviewer validation; do not close or modify #126 as part of Milestone 12 acceptance.

### Issue Checklist

- [x] #122 Persist manual VPS runner identity and assignment. Status: merged; Wave 0 prerequisite for #128 runner auth persistence.
- [x] #125 Show manual runner status and failures. Status: merged; display-only status/log UI slice using persisted manual runner state.
- [x] #127 Initialize Milestone 12 execution tracking. Status: merged; tracking section restored/initialized.
- [x] #128 Add the runner auth persistence contract. Status: merged; provides runner registration-token, credential, heartbeat schema, and reusable secret helpers.
- [x] #129 Implement one-time runner registration. Status: merged; adds visible-once dashboard registration tokens and one-time runner exchange for durable identity plus visible-once credential.
- [x] #130 Authenticate runner heartbeat and offline status. Status: merged; adds scoped heartbeat auth, safe failure responses, last-used updates, online transitions, and stale/missing offline reconciliation.
- [x] #131 Add runner credential rotation and revocation. Status: merged; adds visible-once replacement credentials and revocation enforcement through runner auth.
- [x] #132 Show runner health on assigned agents. Status: merged; adds heartbeat-derived runner health read surfaces.
- [x] #133 Wire runner management controls in settings. Status: merged; adds visible-once registration-token, rotation, and revocation controls.
- [x] #134 Document and verify Milestone 12 acceptance. Status: complete on `codex/issue-134-milestone-12-acceptance`; PR handoff pending.
- Later Milestone 12 issue agents must append new issue rows here before implementation evidence if GitHub adds more Milestone 12 work.

### Current Status

- Milestone 12 goal: dashboard and runner communicate safely with registration, identity, authenticated runner requests, heartbeat, health visibility, and credential rotation/revocation.
- Milestone 12 acceptance criteria from `docs/MILESTONES.md`: unauthorized runner API requests fail; registered runner heartbeat changes status to `online`; missing heartbeat changes status to `offline`; agent pages show runner health; credential revocation prevents further runner communication.
- #127 is tracking-only. It restores the progress record, records the Milestone 12 source plan and issue map, verifies changelog structure, and intentionally leaves `CHANGELOG.md` unchanged because no functional behavior ships in this issue.
- #122 adds durable manual VPS runner identity rows, nullable agent assignment, non-secret development bootstrap/upsert, endpoint validation, and active-agent assigned-runner lookup while preserving no-runner lifecycle behavior.
- #125 adds product-visible manual runner status on dashboard and agent detail using persisted runner assignment/state and safe public runtime log fields; it does not add lifecycle forwarding, runner provisioning, token storage/display, heartbeat/auth behavior, or secret-management UI.
- #128 owns the shared persistence/auth foundation: durable runner identity, one-time registration token state, hashed credential material, heartbeat history, runner status values, optional agent-runner assignment, and reusable token/hash helpers.
- #129 owns one-time runner registration: dashboard token creation, runner exchange for durable identity plus visible-once scoped credential, safe rejection of bad token states, and no hash exposure.
- #130 owns authenticated heartbeat and offline detection: bearer credential enforcement, safe unauthorized failures, heartbeat row writes, last-seen updates, `online` status, and stale-heartbeat `offline` reconciliation.
- #130 now adds `POST /runner/v1/heartbeat`, verifies hashed scoped runner credentials from #128, rejects missing/malformed/unknown/expired/revoked/wrong-runner credentials with safe responses, stores only bounded non-secret metrics, updates credential `lastUsedAt`, and exports `RUNNER_HEARTBEAT_STALE_THRESHOLD_MS` for offline reconciliation.
- #131 owns credential rotation/revocation: visible-once replacement credential, old credential rejection after rotation, revoked credential rejection, and safe credential management errors.
- #131 now adds `POST /api/runners/:runnerId/credentials/rotate` and `POST /api/runners/:runnerId/credentials/revoke` for development-user registered runners, revokes active credential rows before replacement or retirement, returns only a newly generated visible-once credential on rotation, rejects malformed/missing/already-revoked management states safely, and relies on the heartbeat auth path to reject old or revoked credentials.
- #132 owns runner health visibility: assigned agent pages and runner list/read surfaces show real online/offline/degraded state and last-seen context without rendering credential material.
- #133 owns settings controls for registration-token creation, credential rotation, and credential revocation with visible-once secret display and safe UI states.
- #134 owns final operator docs and acceptance evidence mapping after behavior branches merge.
- #134 documents the operator workflow in `README.md`: registration-token creation, registration exchange, bearer heartbeat shape, 90-second offline threshold, rotation, revocation, and visible-once secret handling.
- #134 final acceptance map:
  - Unauthorized runner API requests fail: `tests/unit/runner-heartbeat-route.test.ts` proves missing/malformed Authorization returns `401 runner_unauthorized` before body parsing; `tests/unit/runner-heartbeat.test.ts` proves missing, malformed, unknown, expired, revoked, and wrong-runner credentials do not write heartbeat state.
  - Registered runner heartbeat changes status to `online`: `tests/unit/runner-registration.test.ts` proves one-time exchange creates runner identity and visible-once `agb_run_*` credential with hash-only persistence; `tests/unit/runner-heartbeat.test.ts` proves a valid bearer heartbeat writes a heartbeat row, updates credential `lastUsedAt`, and moves the runner to `online`.
  - Missing heartbeat changes status to `offline`: `tests/unit/runner-heartbeat.test.ts` proves stale and missing heartbeats move online runners to `offline` after `RUNNER_HEARTBEAT_STALE_THRESHOLD_MS = 90000`; `tests/unit/manual-runner-status.test.ts` proves reconciled offline state wins over stale online heartbeat display.
  - Agent pages show runner health: `tests/unit/manual-runner-status.test.ts`, `tests/unit/root-page.test.tsx`, and `tests/e2e/root-route.spec.ts` prove dashboard, assigned-agent detail, and settings show safe runner health, version, and last-seen data while omitting runner IDs, raw credentials, hashes, endpoint credentials, and heartbeat metrics.
  - Credential revocation prevents further runner communication: `tests/unit/runner-credential-lifecycle.test.ts` proves revoke marks active credentials revoked and subsequent heartbeat auth fails; `tests/e2e/root-route.spec.ts` proves settings revocation makes the visible runner credential receive `401` from heartbeat.

### Update Rules

- Every implementation issue must update progress after validation. Add a dated validation entry with the issue number, changed behavior, commands run, pass/fail result, skipped checks with reasons, and remaining risks.
- Update `CHANGELOG.md` only for shipped functional user/operator-visible changes. Do not add changelog entries for tracking-only, validation-only, test-only, or documentation-only work.
- Keep `CHANGELOG.md` in Keep a Changelog shape with `## [Unreleased]`; do not add empty headings or rewrite existing history to satisfy a process checkbox.
- Milestone 12 agents should coordinate merge order for shared `PROGRESS.md` and `CHANGELOG.md` edits, but progress/changelog append conflicts alone should not serialize implementation work.

### Update Log

- 2026-07-05: #127 restored `PROGRESS.md` from the latest tracked progress history after it had been removed by docs cleanup, initialized this Milestone 12 section from `docs/MILESTONES.md`, `docs/PRD.md`, `docs/conversation_dump.md`, GitHub issues #127-#134, and the coordinator decisions in `STATUS.md`.
- 2026-07-05: #127 confirmed `CHANGELOG.md` has Keep a Changelog framing and `## [Unreleased]`; `CHANGELOG.md` is intentionally unchanged for #127 because this issue creates tracking only and ships no functional product behavior.
- 2026-07-05: #122 rebased onto current `origin/main` after #127 restored this tracker, removed generated `next-env.d.ts` build churn from the diff, and recorded validation evidence below.
- 2026-07-05: #123 rebased onto latest `origin/main` after #122 merged, preserved the manual VPS runner service implementation, discarded generated `next-env.d.ts` churn, and appended validation evidence here.
- 2026-07-05: #128 rebased onto current `origin/main` after #123 merged, generated additive runner auth persistence migration `drizzle/0009_worried_switch.sql`, added hash-only runner registration token, credential, and heartbeat schema state, and added reusable runner token/hash helpers.
- 2026-07-05: #124 added assignment-aware dashboard lifecycle forwarding for active agents assigned to `manual_vps` runners, including safe remote start/stop/restart/status/log calls, `manual_runner` log persistence, temporary bearer-token request auth, bounded timeouts, and Docker fallback for unassigned agents.
- 2026-07-05: #124 fast-forwarded onto merged #128 `origin/main` commit `6e5ebfd`, resolved only `PROGRESS.md` and `CHANGELOG.md` append conflicts, preserved the manual-runner lifecycle implementation, and reran focused packaging checks.
- 2026-07-05: #125 implemented dashboard and agent-detail manual runner status panels, assigned-runner offline/degraded alerts, safe manual runner status summaries, dashboard remote/manual runner log inclusion, unit coverage, and seeded Playwright coverage without adding #124 lifecycle forwarding or #128 heartbeat/auth behavior.
- 2026-07-05: #125 rebased onto current `origin/main` after #128 merged, preserved the manual runner status UI/data slice and PostgreSQL advisory-lock Playwright isolation fix, resolved only `PROGRESS.md`/`CHANGELOG.md` append conflicts, and kept `next-env.d.ts` out of the diff.
- 2026-07-05: #125 rebased onto current `origin/main` after #124 merged, resolved only `CHANGELOG.md` and `PROGRESS.md` append conflicts by keeping both #124 and #125 entries, preserved the #125 status/log UI slice and advisory-lock E2E isolation fix, and reran the requested focused checks.
- 2026-07-05: #129 added `POST /api/runners/registration-tokens` for visible-once dashboard registration tokens and `POST /runner/v1/register` for atomic one-time runner exchange into durable runner identity plus visible-once bearer credential, with hash-only persistence and safe rejection for bad token states.
- 2026-07-05: #130 implemented the authenticated runner heartbeat route, scoped credential verification, bounded metric persistence, credential last-use and runner online updates, and stale/missing heartbeat offline reconciliation on `codex/issue-130-runner-heartbeat`.
- 2026-07-05: #131 implemented operator runner credential rotation/revocation routes and a lifecycle service that preserves hash-only persistence, returns only replacement credentials visible-once, and proves old/revoked credentials cannot authenticate through heartbeat.
- 2026-07-05: #132 implemented heartbeat-derived runner health read surfaces on dashboard, assigned-agent detail, and settings, including safe version and last-seen display while omitting runner IDs, credential material, hashes, and heartbeat metrics.
- 2026-07-05: #133 implemented settings runner management controls for visible-once registration-token creation, visible-once credential rotation, credential revocation, safe UI states, and browser proof that dismissed/refreshed raw secrets are not rendered.
- 2026-07-05: #134 documented the Milestone 12 operator workflow, mapped every Milestone 12 acceptance criterion to exact passing automated coverage, marked Milestone 12 complete with the default-parallel verify caveat below, and intentionally left `CHANGELOG.md` unchanged because this branch is docs/evidence-only under the repo's changelog rules.

### Validation Evidence

- 2026-07-05 #134:
  - `bun install --frozen-lockfile`: pass; restored local package binaries in the issue worktree.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:migrate`: pass; migrations applied successfully with existing `drizzle` schema notices only.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:health`: pass; returned `status: ok` and `database: reachable`.
  - `bun run format`: pass; Biome formatted 117 files with no fixes applied.
  - `bun run format:check`: pass; Biome checked 117 files with no fixes applied.
  - `bun run lint`: pass; Biome lint checked 117 files with no fixes applied.
  - `bun run typecheck`: pass; `tsc --noEmit` completed.
  - Initial focused `bun run test -- tests/unit/runner-registration-routes.test.ts tests/unit/runner-registration.test.ts tests/unit/runner-heartbeat-route.test.ts tests/unit/runner-heartbeat.test.ts tests/unit/runner-credential-lifecycle-routes.test.ts tests/unit/runner-credential-lifecycle.test.ts tests/unit/manual-runner-status.test.ts tests/unit/root-page.test.tsx`: environment failure; command omitted `DATABASE_URL` and `NEXT_PUBLIC_APP_URL`, so DB-backed suites failed during env validation before initializing.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism tests/unit/runner-registration-routes.test.ts tests/unit/runner-registration.test.ts tests/unit/runner-heartbeat-route.test.ts tests/unit/runner-heartbeat.test.ts tests/unit/runner-credential-lifecycle-routes.test.ts tests/unit/runner-credential-lifecycle.test.ts tests/unit/manual-runner-status.test.ts tests/unit/root-page.test.tsx`: pass; 8 files and 67 tests passed for registration, heartbeat auth, offline reconciliation, credential rotation/revocation, runner health summaries, settings controls, and page rendering.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: pass; Next.js compiled, typechecked, generated static pages, and listed `/api/runners/registration-tokens`, `/runner/v1/register`, `/runner/v1/heartbeat`, credential lifecycle routes, `/dashboard`, `/agents/[agentId]`, and `/settings`.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism`: pass before aggregate verify; 35 files and 302 tests passed.
  - `PORT=3134 DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3134 bun run test:e2e -- --project=chromium-desktop -g "manual runner status, alerts, and remote logs stay visible and safe"`: pass; 1 browser smoke passed, covering dashboard/settings online and offline runner health, assigned-agent offline alerts, visible-once `agb_reg_*` display/dismissal, rotate visible-once `agb_run_*` display/dismissal, old credential heartbeat rejection after rotation, revoke confirmation/success, revoked credential heartbeat rejection, refresh hiding raw secrets, and safe omission of hashes/unsafe server error text.
  - `PORT=3134 DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3134 bun run test:e2e -- --workers=1`: pass; 41 browser tests passed and 19 project skips were expected.
  - `PORT=3134 DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3134 bun run verify`: failed at the default-parallel `bun run test` stage after `format:check`, `lint`, and `typecheck` passed. The failing default-parallel Vitest run reported 5 failed files and 21 failed tests out of 302 with the known shared-DB isolation class: Postgres deadlocks, foreign-key races, timed-out tests, missing rows, and `agent_not_found` after parallel DB-backed files truncated shared tables concurrently.
  - Post-verify classification rerun: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism` passed; 35 files and 302 tests passed, confirming the aggregate failure is the pre-existing default-parallel shared-DB isolation path rather than a #134 docs/evidence regression.

- 2026-07-05 #133:
  - Initial `bun run format`: environment failure before install; `biome` binary was unavailable in the worktree.
  - `bun install --frozen-lockfile`: pass; restored local package binaries from `bun.lock`.
  - `bun run format`: pass; Biome formatted app, source, script, test, CSS, TS, and JSON files.
  - `bun run test -- tests/unit/manual-runner-status.test.ts tests/unit/root-page.test.tsx`: pass; 2 files and 31 tests passed for settings runner management summaries, page rendering, visible controls, and negative raw secret/hash assertions.
  - `bun run typecheck`: pass; `tsc --noEmit` completed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:health`: pass; returned `status: ok` and `database: reachable`.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:migrate`: pass; migrations applied successfully with existing `drizzle` schema notices only.
  - `PORT=3133 DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3133 bun run test:e2e -- --project=chromium-desktop -g "manual runner status, alerts, and remote logs stay visible and safe"`: pass; 1 browser smoke passed for settings create-token loading/error/success, visible-once `agb_reg_*` display and dismissal, credential rotate validation/loading/success, visible-once `agb_run_*` display and dismissal, old credential heartbeat rejection after rotation, revoke confirmation/loading/success, revoked credential heartbeat rejection, refresh hiding dismissed raw secrets, and safe omission of hashes/unsafe server error text.
  - `bun run format:check`: pass; Biome checked 117 files with no fixes applied.
  - Initial `bun run lint`: failed on two accessibility rules in `runner-management-controls` (`aria-label` on a plain `div` and `div role="region"`); fixed by using semantic `section` elements.
  - `bun run lint`: pass; Biome lint checked 117 files with no fixes applied.
  - `bun run test -- tests/unit/manual-runner-status.test.ts tests/unit/root-page.test.tsx tests/unit/runner-registration-routes.test.ts tests/unit/runner-credential-lifecycle-routes.test.ts`: pass; 4 files and 42 tests passed for settings/page coverage plus adjacent create/rotate/revoke route contracts.
  - Static production-path scans: pass; `rg` found no long raw `agb_reg_*` or `agb_run_*` literals in `app`/`src`, no production logging or hash rendering in settings/control paths, and long secret-looking values only in intentional test fixtures/negative assertions.
  - `git diff --check`: pass; no whitespace errors.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism`: pass; 35 files and 302 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: pass; Next.js compiled, typechecked, generated static pages, and listed the runner management API routes plus `/settings`.
  - Final `PORT=3133 DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3133 bun run test:e2e -- --project=chromium-desktop -g "manual runner status, alerts, and remote logs stay visible and safe"`: pass; 1 browser smoke passed on the final files. The run emitted the existing PostgreSQL advisory-unlock warning from shared test cleanup, but the test passed.
  - Full default-parallel `bun run verify` was not run because focused tests, package checks, production build, targeted browser smoke, serialized aggregate unit, and static scans passed, and this repo has known shared-DB default-parallel isolation risk recorded above.

- 2026-07-05 #132:
  - Initial `bun run format`: environment failure before install; `biome` binary was unavailable in the worktree.
  - `bun install --frozen-lockfile`: pass; restored local package binaries from `bun.lock`.
  - `bun run format`: pass; Biome formatted app, source, script, test, CSS, TS, and JSON files.
  - `bun run test -- tests/unit/manual-runner-status.test.ts tests/unit/root-page.test.tsx`: pass; 2 files and 29 tests passed for heartbeat-derived runner health summaries, dashboard/detail/settings rendering, online/offline visibility, safe version/last-seen output, and negative assertions for runner IDs, credential hashes, token hashes, and heartbeat metrics.
  - `bun run format:check`: pass; Biome checked 111 files with no fixes applied.
  - `bun run lint`: pass; Biome lint checked 111 files with no fixes applied.
  - `bun run typecheck`: pass; `tsc --noEmit` completed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:health`: pass; returned `status: ok` and `database: reachable`.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:migrate`: pass; migrations applied successfully with existing `drizzle` schema notices only.
  - `PORT=3132 DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3132 bun run test:e2e -- --project=chromium-desktop -g "manual runner status, alerts, and remote logs stay visible and safe"`: pass; 1 Playwright smoke passed, proving dashboard and settings show online and offline runner health with safe version/last-seen fields, assigned agent detail shows offline runner health and alerts, and UI omits raw endpoint credentials, runner IDs, credential/token hashes, and heartbeat metric keys.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: pass; Next.js compiled, typechecked, generated static pages, and listed `/dashboard`, `/agents/[agentId]`, `/settings`, and runner API routes.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism`: pass; 33 files and 292 tests passed.
  - Final `bun run format:check`, `bun run lint`, `bun run typecheck`, and `git diff --check`: pass after progress/changelog updates.
  - Full `bun run verify` was not run because the targeted browser smoke, production build, serialized unit suite, and package checks passed, and this repo's default parallel verify path has known shared-DB isolation risk recorded above.

- 2026-07-05 #129:
  - `bun install`: pass; restored local package shims after initial `bun run format` failed with `/opt/homebrew/bin/bash: line 1: biome: command not found`.
  - `bun run format`: pass; Biome formatted the new registration route, service, and test files.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- tests/unit/runner-registration-routes.test.ts tests/unit/runner-registration.test.ts`: pass; 2 files and 10 tests passed for visible-once create/exchange responses, safe validation/errors, hash-only persistence, bad token states, and concurrent one-time exchange behavior.
  - `bun run format:check`: pass; Biome checked 107 files with no fixes applied.
  - `bun run lint`: pass; Biome lint checked 107 files with no fixes applied.
  - `bun run typecheck`: pass; `tsc --noEmit` completed.
  - Isolated DB setup for broader validation: `DROP DATABASE IF EXISTS agentbay_129_check WITH (FORCE)`, `CREATE DATABASE agentbay_129_check`, and `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay_129_check NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:migrate` all passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay_129_check NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- tests/unit/runner-registration-routes.test.ts tests/unit/runner-registration.test.ts`: pass; 2 files and 10 tests passed on isolated DB after avoiding parallel validation-command collision.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay_129_check NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism`: pass; 31 files and 272 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay_129_check NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: pass; Next.js compiled, typechecked, generated pages, and listed `/api/runners/registration-tokens` and `/runner/v1/register`.
  - `rg -n "console\\.(log|error|warn|info)|tokenHash|credentialHash|agb_reg_[A-Za-z0-9_-]{20,}|agb_run_[A-Za-z0-9_-]{20,}|rawToken|rawCredential|postgres://[^ ]*@" app/api/runners app/runner src/server/runners/runner-registration.ts tests/unit/runner-registration*.test.ts -S`: pass after review; matches are stored hash field names in service code and synthetic test tokens/negative assertions only, with no runtime logging or raw secret persistence.
  - `git diff --check`: pass; no whitespace errors.
  - Skipped full E2E because #129 adds server-side registration routes and service behavior only; no browser UI workflow changed. Earlier accidental parallel validation commands against the same isolated DB produced deadlocks/resets, then passed when rerun serially.

- 2026-07-05 #130:
  - `bun install`: pass; restored local package shims after initial focused test/typecheck attempts failed with `vitest: command not found` and `tsc: command not found`.
  - Initial `bun run test -- tests/unit/runner-heartbeat-route.test.ts`: environment failure before install; `vitest` binary was unavailable in the worktree.
  - Initial `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- tests/unit/runner-heartbeat.test.ts`: environment failure before install; `vitest` binary was unavailable in the worktree.
  - Initial `bun run typecheck`: environment failure before install; `tsc` binary was unavailable in the worktree.
  - `bun run test -- tests/unit/runner-heartbeat-route.test.ts`: pass; 7 route tests passed for accepted heartbeats, safe auth/forbidden mappings, malformed JSON, and persistence errors without echoing credentials.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- tests/unit/runner-heartbeat.test.ts`: pass; 9 persistence tests passed for valid heartbeat writes, metric sanitization, credential `lastUsedAt`, online status, missing/malformed/unknown/expired/revoked/wrong-runner failures, payload validation, and stale/missing heartbeat offline reconciliation.
  - `bun run typecheck`: pass; `tsc --noEmit` completed.
  - `bun run format:check`: pass after targeted Biome formatting; Biome checked 106 files with no fixes applied.
  - `bun run lint`: pass; Biome checked 106 files with no fixes applied.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:migrate`: pass; migrations applied successfully with existing `drizzle` schema notices only.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: pass; Next.js compiled, typechecked, generated static pages, and listed the new `/runner/v1/heartbeat` dynamic route.
  - `git diff --check`: pass; no whitespace errors.
  - Static secret scan over the #130 route/helper/tests plus `PROGRESS.md` and `CHANGELOG.md`: pass; no real provider keys, private keys, GitHub tokens, `AGENTBAY_RUNNER_BEARER_TOKEN`, or generated runner credential literals were found.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism`: baseline failure outside #130 after 30 files and 276 tests passed; `tests/unit/create-agent-db.test.ts` had two failures: rollback expected preserved `agent_events` but received `[]`, and the existing start-route behavior expected `202` but received `500`.
  - Baseline confirmation on current `main`: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- tests/unit/create-agent-db.test.ts -t "rolls back config and agent updates when config event writing fails|exposes the start route success, validation, not-found, deleted, invalid status, and event behavior"` failed with the same start-route `expected 202, received 500` assertion. The rollback subcase passed when isolated by the focused filter.
  - Full E2E was not run because #130 adds a server runner endpoint and offline helper with focused route/persistence coverage; existing repo notes already record shared DB/E2E isolation risks for broader suites.

- 2026-07-05 #131:
  - Initial `bun run test -- tests/unit/runner-credential-lifecycle-routes.test.ts`: environment failure before install; `vitest` binary was unavailable in the worktree.
  - Initial `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- tests/unit/runner-credential-lifecycle.test.ts`: environment failure before install; `vitest` binary was unavailable in the worktree.
  - `bun install`: pass; restored local package shims for Vitest, Biome, TypeScript, and Next.js in the issue worktree.
  - `bun run test -- tests/unit/runner-credential-lifecycle-routes.test.ts`: pass; 1 route file and 5 tests passed for rotate visible-once response shape, revoke response shape, malformed runner ID validation, missing runner errors, already-revoked errors, persistence failure mapping, and no hash/raw-secret exposure.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- tests/unit/runner-credential-lifecycle.test.ts`: pass; 1 DB-backed file and 3 tests passed for hash-only rotation persistence, old credential rejection through heartbeat auth, new credential heartbeat success, revoked credential heartbeat rejection, and safe malformed/missing/already-revoked management failures.
  - `bun run format`: pass; Biome formatted the new lifecycle service, routes, and tests.
  - Initial `bun run lint`: warning; unused test import after a small edit, then fixed.
  - `bun run lint`: pass; Biome lint checked 116 files with no fixes applied.
  - `bun run typecheck`: pass; `tsc --noEmit` completed.
  - `bun run format:check`: pass; Biome checked 116 files with no fixes applied.
  - Isolated DB setup for broader validation: `DROP DATABASE IF EXISTS agentbay_131_check WITH (FORCE)`, `CREATE DATABASE agentbay_131_check`, and `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay_131_check NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:migrate` all passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay_131_check NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:health`: pass; returned `status: ok` and `database: reachable`.
  - `bun run test -- tests/unit/runner-credential-lifecycle-routes.test.ts`: pass after final formatting; 1 file and 5 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay_131_check NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- tests/unit/runner-credential-lifecycle.test.ts`: pass on isolated DB; 1 file and 3 tests passed.
  - Default-parallel adjacent runner-auth command failed with known shared-table DB reset symptoms: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay_131_check NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- tests/unit/runner-registration-routes.test.ts tests/unit/runner-registration.test.ts tests/unit/runner-heartbeat-route.test.ts tests/unit/runner-heartbeat.test.ts tests/unit/runner-credential-lifecycle-routes.test.ts tests/unit/runner-credential-lifecycle.test.ts` produced Postgres deadlocks, foreign-key races, and duplicate `app_metadata` rows while DB-backed files truncated shared tables in parallel.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay_131_check NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism tests/unit/runner-registration-routes.test.ts tests/unit/runner-registration.test.ts tests/unit/runner-heartbeat-route.test.ts tests/unit/runner-heartbeat.test.ts tests/unit/runner-credential-lifecycle-routes.test.ts tests/unit/runner-credential-lifecycle.test.ts`: pass; 6 files and 36 adjacent runner-auth tests passed serialized.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay_131_check NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism`: pass; 35 files and 298 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay_131_check NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: pass; Next.js compiled, typechecked, generated static pages, and listed `/api/runners/[runnerId]/credentials/rotate` and `/api/runners/[runnerId]/credentials/revoke`. Generated `next-env.d.ts` build churn was reverted from the patch.
  - Production-path secret/logging scan over `app/api/runners/[runnerId]` and `src/server/runners/runner-credential-lifecycle.ts`: pass; no runtime logging, generated raw credential literals, raw-token fields, private keys, provider keys, GitHub tokens, or DSNs. The only `credentialHash` match is the intentional hash-only persistence write.
  - `git diff --check`: pass; no whitespace errors.
  - Full E2E was not run because #131 adds server-side operator credential lifecycle APIs and DB/auth service behavior only; no browser UI workflow changed, and #133 owns settings UI controls.

- 2026-07-05 #125:
  - `bun install`: pass; restored local package shims in this worktree after `bun run format` initially failed with `/opt/homebrew/bin/bash: line 1: biome: command not found`.
  - `bun run format`: pass; Biome formatted the changed app, server, test, and CSS files.
  - `bun run format:check`: pass; Biome checked 98 files with no fixes applied.
  - `bun run lint`: pass; Biome lint checked app, src, scripts, tests, and root TS/JSON files with no fixes applied.
  - `bun run typecheck`: pass; `tsc --noEmit` completed successfully.
  - `bun run test -- tests/unit/manual-runner-status.test.ts tests/unit/root-page.test.tsx tests/unit/agent-logs-route.test.ts`: pass; 45 focused tests passed for safe runner status summaries, dashboard/detail runner rendering, safe log DTO output, and remote/manual runner log visibility.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3125 bun run test`: pass; 27 files and 246 tests passed.
  - `PORT=3125 DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3125 bun run test:e2e -- --project=chromium-desktop --project=chromium-mobile -g "manual runner status"`: pass; 2 Playwright tests passed, covering dashboard runner status, assigned-runner detail, offline alert text, remote/manual runner logs, safe omission of raw endpoint credentials, runner IDs, `runnerId`, `runner_id`, stack traces, database URLs, and mobile overflow.
  - `PORT=3125 DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3125 bun run build`: pass; Next.js production build completed and included `/dashboard`, `/agents/[agentId]`, and `/api/agents/[agentId]/logs`.
  - `PORT=3125 DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3125 bun run test:e2e`: failed in the existing full parallel E2E suite; targeted #125 test passed in the same run on mobile and passes standalone on desktop/mobile, while unrelated/full-suite failures included shared DB foreign-key races in existing process-log specs, 500s from existing create-agent flows, Docker final-acceptance failures, and old shared-state runtime-log specs. This is recorded as a full-suite environment/isolation blocker, not a #125 targeted coverage failure.
  - Post-#128 rebase `git status --short --branch --untracked-files=all`: pass; branch is current with `origin/main`, dirty only with the intended #125 implementation/tracker files, and `next-env.d.ts` is absent.
  - Post-#128 rebase `git diff --name-status origin/main...HEAD`: pass; empty because the #125 implementation remains uncommitted worktree state on top of current `origin/main`.
  - Post-#128 rebase `git diff --name-status origin/main && git ls-files --others --exclude-standard`: pass; working-tree diff is limited to #125 dashboard/detail/status/log/test/tracker files plus new `manual-runner-status` helper and test.
  - Post-#128 rebase `bun run format:check`: pass; Biome checked 100 files with no fixes applied.
  - Post-#128 rebase `bun run test -- tests/unit/manual-runner-status.test.ts tests/unit/root-page.test.tsx tests/unit/agent-logs-route.test.ts`: pass; 45 focused tests passed.
  - Post-#128 rebase clean DB setup: pass; `agentbay_125_check` was recreated, migrations applied successfully through #128, and `db:health` returned `status: ok`.
  - Post-#128 rebase `PORT=3125 DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay_125_check NEXT_PUBLIC_APP_URL=http://localhost:3125 bun run test:e2e -- --project=chromium-desktop --project=chromium-mobile -g "manual runner status"`: pass; 2 tests passed using 2 workers.
  - Post-#124 rebase `git status --short --branch --untracked-files=all`: pass; branch is rebased on `origin/main` and ahead of/behind the pre-rebase PR remote before force-push.
  - Post-#124 rebase `git diff --check`: pass; no whitespace errors.
  - Post-#124 rebase `bun run format:check`: pass; Biome checked 102 files with no fixes applied.
  - Post-#124 rebase `bun run test -- tests/unit/manual-runner-status.test.ts tests/unit/root-page.test.tsx tests/unit/agent-logs-route.test.ts`: pass; 46 focused tests passed for safe manual runner summaries, dashboard/detail rendering, lifecycle-runner log reads, and public log DTO safety.
  - Post-#124 rebase clean DB setup: pass; `agentbay_125_check` was recreated and migrations applied successfully through merged #124.
  - Post-#124 rebase `PORT=3125 DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay_125_check NEXT_PUBLIC_APP_URL=http://localhost:3125 bun run test:e2e -- --project=chromium-desktop --project=chromium-mobile -g "manual runner status"`: pass; 2 tests passed using 2 default Playwright workers across desktop and mobile.

- 2026-07-05 #122:
  - `git status --short --branch --untracked-files=all`: pass; branch is rebased onto `origin/main`, #122 implementation files remain dirty/untracked as intended, and `next-env.d.ts` is not modified.
  - `git diff --name-status`: pass; tracked diff is limited to `.env.example`, `CHANGELOG.md`, `README.md`, Drizzle metadata, env/schema helpers, and focused unit tests.
  - `bun run format:check`: pass; Biome checked 92 files with no fixes applied.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun test tests/unit/agent-schema.test.ts tests/unit/env-validation.test.ts tests/unit/create-agent-db.test.ts`: pass; 122 tests passed, including manual runner schema/migration shape, endpoint validation, idempotent non-secret bootstrap, assigned-runner lookup, soft-delete/other-user exclusions, and no-runner lifecycle preservation.
  - Full DB migrate/health, lint, typecheck, aggregate unit test, and production build evidence remains from the pre-rebase #122 checker pass in `STATUS.md`; not rerun because the rebase was clean and only `PROGRESS.md` changed after focused validation.

- 2026-07-05 #127:
  - `test -f PROGRESS.md`: pass.
  - `rg -n "Milestone 12 Secure Runner Auth|#127|#128|#129|#130|#131|#132|#133|#134|update progress after validation|changelog" PROGRESS.md`: pass; matched the Milestone 12 heading, #127-#134 checklist/status rows, update-progress rule, and changelog rule.
  - `rg -n "Keep a Changelog|## \\[Unreleased\\]" CHANGELOG.md`: pass; matched the Keep a Changelog framing and `## [Unreleased]`.
  - `git diff -- PROGRESS.md CHANGELOG.md`: pass for review; diff contains the restored `PROGRESS.md` plus this Milestone 12 section, and no `CHANGELOG.md` changes.
  - `bun run format:check`: skipped after attempted run failed with `biome: command not found`; `node_modules` is missing in this worktree, `command -v biome` returned no binary, and #127 explicitly forbids editing `node_modules`.

- 2026-07-05 #123:
  - `git rebase origin/main`: pass after resolving expected `.env.example` and `PROGRESS.md` merge-order conflicts with #122; branch `codex/issue-123-manual-runner-service` is current with `origin/main`.
  - `git restore -- next-env.d.ts`: pass; removed generated Next route-type import churn from the #123 diff before rebasing.
  - `git status --short --branch --untracked-files=all`: pass; branch is current with `origin/main`, with intended #123 runner-service files plus docs/package updates and `PROGRESS.md`.
  - `git diff --name-status`: pass; no `next-env.d.ts` diff remains.
  - `bun run format:check`: pass; Biome checked 95 files with no fixes applied.
  - `bun run typecheck`: pass; `tsc --noEmit` completed after the rebase and generated-file cleanup.

- 2026-07-05 #128:
  - `git rebase origin/main`: pass; branch rebased onto `af36ae5 feat: add manual runner service` before final validation.
  - `bun run db:generate`: pass; generated additive `drizzle/0009_worried_switch.sql`, and the post-rebase rerun reported no schema changes.
  - `bun run format`: pass; Biome formatted 98 files.
  - `bun run lint`: pass; Biome checked 98 files with no fixes applied.
  - `bun run typecheck`: pass; `tsc --noEmit` completed successfully.
  - `bun test tests/unit/agent-schema.test.ts`: pass; 19 tests passed, covering new runner auth tables, expanded runner statuses, migration shape, hash-only storage, and important indexes.
  - `bun test tests/unit/runner-auth-secrets.test.ts`: pass; 4 tests passed, covering registration token creation, credential creation, hashing, verification, and empty-secret errors without echoing input.
  - `bun run db:migrate`: pass; migrations applied successfully on `postgres://agentbay:agentbay@127.0.0.1:54329/agentbay`.
  - `bun run db:health`: pass; database reported `status: ok` and `database: reachable`.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run verify`: partial pass; format, lint, typecheck, all 250 unit tests, and production build passed, then parallel E2E failed in two Docker lifecycle waits for `running`.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bunx playwright test tests/e2e/root-route.spec.ts --project=chromium-desktop --grep '/dashboard shows Docker logs captured by observing a running agent|/agents creates Research Agent and persists it across read surfaces'`: pass; both previously failed desktop E2E flows passed on targeted rerun.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test:e2e -- --workers=1`: pass; 39 passed and 19 skipped, confirming the aggregate E2E failure was parallel-runner sensitive rather than #128 persistence behavior.
  - `rg -n "raw[_-]?(token|credential|secret)|\"token\"\\s+text|\"credential\"\\s+text|console\\.(log|error|warn|info)|AGB_|agb_reg_[A-Za-z0-9_-]{8,}|agb_run_[A-Za-z0-9_-]{8,}" src/server/db/schema.ts src/server/runners/runner-auth-secrets.ts tests/unit/agent-schema.test.ts tests/unit/runner-auth-secrets.test.ts drizzle/0009_worried_switch.sql`: pass; matches were only negative assertions in the schema test, with no raw secret columns, generated raw token literals, or helper logging calls.

- 2026-07-05 #124:
  - `git merge --ff-only origin/main`: pass; branch advanced from #123 base `af36ae5` to merged #128 commit `6e5ebfd` before reapplying the #124 implementation.
  - `git stash pop`: pass with expected append-only conflicts in `CHANGELOG.md` and `PROGRESS.md`; no code, migration, schema, or public lifecycle response-shape conflicts occurred.
  - `git status --short --branch --untracked-files=all`: pass after sync; branch is current with `origin/main`, intended dirty files are #124 lifecycle/log/test/progress/changelog files plus untracked `src/server/runners/manual-runner-adapter.ts` and `tests/unit/manual-runner-adapter.test.ts`, and no `next-env.d.ts` churn is present.
  - `git diff --name-status origin/main...HEAD`: pass; empty because #124 remains uncommitted after the fast-forward and dirty worktree reapply.
  - `rg -n "#124|manual_vps|manual_runner|Dashboard lifecycle forwarding|assignment-aware dashboard lifecycle forwarding|manual runner agent|assigned manual|falls back to the Docker lifecycle|manual-runner-adapter" PROGRESS.md CHANGELOG.md src/server/agents/lifecycle.ts src/server/runners/manual-runner-adapter.ts tests/unit/manual-runner-adapter.test.ts tests/unit/create-agent-db.test.ts tests/unit/agent-logs-route.test.ts 'app/api/agents/[agentId]/logs/route.ts'`: pass; matched the progress/changelog #124 evidence, manual-runner adapter import, `manual_runner` persisted log source, assigned manual lifecycle tests, log-route tests, and Docker fallback coverage.
  - `bun run format:check`: pass after the #128 sync; Biome checked 100 files with no fixes applied.
  - `bun run typecheck`: pass after the #128 sync; `tsc --noEmit` completed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- tests/unit/manual-runner-adapter.test.ts`: pass after the #128 sync; 3 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- tests/unit/agent-logs-route.test.ts`: pass after the #128 sync; 19 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- tests/unit/create-agent-db.test.ts -t "assigned manual|manual runner agent|falls back to the Docker lifecycle"`: pass after the #128 sync; 4 tests passed and 102 skipped by the focused filter.
  - `bun run lint` and `bun run build`: not rerun after sync because the only merge conflicts were append-only `PROGRESS.md` and `CHANGELOG.md` conflicts; no code/schema conflicts were resolved.
  - `bun install`: pass; restored local worktree dependencies for validation.
  - `bun run format:check`: pass; Biome checked 98 files with no fixes applied after formatting the #124 implementation files.
  - `bun run lint`: pass; Biome checked 98 files with no fixes applied.
  - `bun run typecheck`: pass; `tsc --noEmit` completed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- tests/unit/manual-runner-adapter.test.ts`: pass; 3 tests covered local loopback HTTP, HTTPS enforcement for non-loopback endpoints, missing-token safe failure, Authorization header injection, start/logs/stop/restart contract calls, bounded timeout configuration, and persisted `manual_runner` logs without token exposure.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- tests/unit/agent-logs-route.test.ts`: pass; 19 tests covered assignment-aware remote log streaming, safe public DTO fields, and existing stopped/running log route behavior.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- tests/unit/create-agent-db.test.ts -t "assigned manual|manual runner agent|falls back to the Docker lifecycle"`: pass; 4 focused lifecycle DB tests covered assigned manual start success with persisted logs, remote start failure without marking running, selected-agent stop/restart targeting, and Docker fallback for unassigned agents.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- --no-file-parallelism`: pass; 27 files and 250 tests passed with DB-backed files serialized.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: pass; Next.js compiled, type-checked, generated static pages, and listed the expected dynamic API/dashboard routes.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun test`: failed as a baseline native Bun runner mismatch: Vitest-only `vi.hoisted` route/component tests and Playwright specs are not compatible with native `bun test`; DB-backed suites also deadlocked when native/parallel resets shared the same Postgres. The configured aggregate `bun run test -- --no-file-parallelism` passed.
  - Initial parallel `bun run test` also deadlocked DB-backed reset/truncate suites on shared Postgres; rerun with `--no-file-parallelism` passed and is the usable aggregate signal for this worktree.

## Milestone 9 Local Runner Persistence

- Status: complete for #71/#72/#73/#74/#75; Milestone 9 is ready for checker review.
- Source plan: `docs/MILESTONES.md` Milestone 9
- Tracking issues: #71-#75
- Current branch: `codex/issue-75-local-runner-acceptance`
- Next step: checker should review the final documentation updates, stale fake-lifecycle wording cleanup, and acceptance evidence below.

### Issue Checklist

- [x] #71 Persist local runner state and agent logs
- [x] #72 Implement the local runner adapter with a dummy process
- [x] #73 Expose persisted process logs in the dashboard
- [x] #74 Run lifecycle controls through the local runner
- [x] #75 Document and verify the Milestone 9 local runner
- Later Milestone 9 issue agents must append new issue rows here before implementation evidence if GitHub adds more Milestone 9 work.

### Current Status

- #71 owns the Milestone 9 persistence foundation for local runner process metadata and agent stdout/stderr log storage/read helpers only. It does not implement process spawning, dashboard log surfaces, lifecycle controls, Docker/cloud runners, runner auth, Hermes, Telegram, BYOK, billing, or production supervision.
- #71 adds an additive `local_runner_processes` table with process id, sanitized command metadata, status, start/stop timestamps, exit code, signal, and sanitized last-error storage scoped to active local-development agents.
- #71 links `agent_logs` rows to an optional local runner process id, constrains persisted streams to `stdout` or `stderr`, preserves per-agent sequence ordering, and keeps process output separate from `agent_events`.
- #71 adds local runner state helpers for creating process rows, recording terminal state, appending stdout/stderr log lines, and reading process-scoped logs without spawning or controlling processes.
- #72 adds the local runner adapter interface with `start`, `stop`, `restart`, `status`, and persisted log-stream reads while leaving lifecycle route replacement to #74 and dashboard log UI to #73.
- #72 defaults to a real dummy Node child process and keeps future Hermes execution behind explicit `AGENTBAY_LOCAL_RUNNER_EXECUTABLE` plus JSON argv configuration.
- #72 spawns child processes with executable plus argument array and `shell: false`, records the child pid in `local_runner_processes`, captures stdout/stderr into process-scoped `agent_logs`, records stopped state for intentional stops, and records failed/exited state for unexpected exits.
- #72 adds a latest-process state read helper for active local-development agents so adapter `status` and `stop` can use the #71 durable state contract without dashboard, endpoint, Docker, cloud, auth, billing, provider, Telegram, or Hermes integration work.
- #73 adds a latest active-agent process log read helper that returns public DTOs with agent names/links, filters out soft-deleted agents, ignores non-process simulator rows, and preserves stable newest-first ordering by timestamp and sequence.
- #73 adds a dashboard Latest process logs panel with stdout/stderr, timestamp, level, sequence, redacted summaries, empty state, safe failure state, and direct links to each agent detail log stream.
- #73 keeps internal runner/process identifiers available to server helpers but strips `runnerId` and `localRunnerProcessId` from the product `GET /api/agents/:agentId/logs` response.
- #73 returns sanitized public log messages from the product `GET /api/agents/:agentId/logs` response, reusing the operational summarizer to omit token-like values, redact Postgres URLs, and drop stack-frame paths.
- #73 keeps lifecycle controls/status pills unchanged and does not implement process spawning, local runner adapter behavior, lifecycle endpoint replacement, Docker/cloud runners, Hermes, Telegram, auth, billing, provider integrations, or secrets.
- #72 scopes process-id log streaming to the requested active local-development agent at the state helper boundary, so a known process UUID for another agent returns no logs through both the helper and adapter.
- #72 terminates spawned-but-untracked child processes when start-time durable state persistence fails, including defensive handling for already-exited children and cleanup kill failures.
- #74 wires the existing Start/Stop/Restart API and dashboard/detail/mobile controls to the #72 local runner adapter without changing the public control model.
- #74 start validates the current agent state, starts a real local child process, then persists `running` with start requested/completed events only after spawn and durable process state succeed.
- #74 stop requires a tracked managed local runner process, terminates it through the adapter, then persists `stopped` with stop requested/completed events.
- #74 restart terminates the old tracked process, starts a replacement, stays in `running`, and records restart requested/completed events with the replacement local runner process id.
- #74 records unexpected lifecycle-launched process exits as `error` with safe status reason, persisted process exit details, captured stdout/stderr logs, and one `agent.error` audit event.
- #74 leaves invalid lifecycle actions as safe validation/conflict responses without runner calls, state mutation, or mutation events.
- #74 keeps Docker/cloud/Hermes/provider/auth/billing/secrets and Docker runtime metadata out of scope.
- #75 updates README operator docs to describe the local runner adapter, dummy runner default, optional executable/argv configuration, lifecycle behavior, stdout/stderr log storage, unexpected crash behavior, and local validation workflow.
- #75 corrects stale product/docs wording that described current lifecycle controls as deterministic fake lifecycle behavior or said Milestone 9 did not spawn real processes.
- #75 keeps `CHANGELOG.md` unchanged because the issue is documentation, copy correction, and final evidence only; no new user/operator-visible runtime behavior was added.
- #75 marks Milestone 9 completed in `docs/MILESTONES.md` after final acceptance evidence and aggregate validation passed.

### Validation

#### #75

- Date: 2026-07-04
- Environment:
  - Isolated database target: container `agentbay_issue_75-postgres` on host port `54375`, `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54375/agentbay`.
  - Isolated app/test server target: `PORT=3075`, `PLAYWRIGHT_BASE_URL=http://localhost:3075`, `NEXT_PUBLIC_APP_URL=http://localhost:3075`.
- Setup:
  - `test -d node_modules && echo node_modules-present || echo node_modules-missing`: pass; reported `node_modules-missing` before setup.
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile.
  - `docker info --format '{{.ServerVersion}}'`: pass; Docker daemon reachable with server version `29.3.1`.
  - `docker ps -a --filter name=agentbay_issue_75-postgres --format '{{.Names}} {{.Status}} {{.Ports}}'`: pass; no existing #75 container was present before setup.
  - `docker run --name agentbay_issue_75-postgres -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54375:5432 -d postgres:17-alpine`: pass; started isolated Postgres for #75.
  - `docker exec agentbay_issue_75-postgres pg_isready -U agentbay -d agentbay`: pass; Postgres accepted connections.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54375/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3075 bun run db:migrate`: pass; migrations applied successfully.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54375/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3075 bun run db:health`: pass; returned `status: ok` and `database: reachable`.
- Focused acceptance checks:
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54375/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3075 bun run test -- tests/unit/create-agent-db.test.ts tests/unit/local-runner-adapter.test.ts tests/unit/root-page.test.tsx`: pass; 3 files and 108 tests passed.
  - Evidence from the focused unit suite: local runner command configuration defaults to the dummy Node process and accepts explicit executable/argv configuration; start records a real child pid and status; stop terminates the tracked managed child; stdout/stderr process lines persist in `agent_logs`; lifecycle-launched crash moves the agent to `error` and writes `agent.error`; dashboard copy keeps existing lifecycle controls while no longer describing them as fake lifecycle controls.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54375/agentbay PORT=3075 PLAYWRIGHT_BASE_URL=http://localhost:3075 NEXT_PUBLIC_APP_URL=http://localhost:3075 bun run test:e2e -- --project=chromium-desktop --grep "dashboard shows latest persisted process logs|scoped runtime logs|creates Research Agent"`: failed in the first combined targeted run; the dashboard process-log case passed, while the two lifecycle cases received `Agent could not be started.` during concurrent DB-mutating execution.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54375/agentbay PORT=3075 PLAYWRIGHT_BASE_URL=http://localhost:3075 NEXT_PUBLIC_APP_URL=http://localhost:3075 bun run test:e2e -- tests/e2e/root-route.spec.ts:604 --project=chromium-desktop --workers=1`: pass; the browser create/lifecycle flow proved existing dashboard lifecycle controls and status pills remain the control model across Start, Restart, and Stop.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54375/agentbay PORT=3075 PLAYWRIGHT_BASE_URL=http://localhost:3075 NEXT_PUBLIC_APP_URL=http://localhost:3075 bun run test:e2e -- tests/e2e/root-route.spec.ts:1312 --project=chromium-desktop --workers=1`: pass; the detail runtime log flow proved the local dummy runner stdout/stderr lines are persisted and visible in the product log experience.
- Final aggregate gate:
  - The #75 Postgres container was reset before final aggregate validation with `docker rm -f -v agentbay_issue_75-postgres`, recreated on host port `54375`, and migrated successfully.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54375/agentbay PORT=3075 PLAYWRIGHT_BASE_URL=http://localhost:3075 NEXT_PUBLIC_APP_URL=http://localhost:3075 bun run verify`: pass; aggregate format, lint, typecheck, unit test, production build, and Playwright gates passed with 207 unit tests and 38 E2E passed / 18 expected skips.
- Acceptance evidence map:
  - README accuracy: updated for the adapter, default dummy process, optional executable/argv env vars, lifecycle behavior, log storage, crash behavior, and local validation workflow.
  - Stale fake-runner wording: `rg -n "fake lifecycle|deterministic fake lifecycle|does not spawn|does not spawn or supervise|real processes do not exist|runner processes do not exist|logs .*do not exist" README.md app tests/unit/root-page.test.tsx docs/MILESTONES.md` returns only the intentional Milestone 9 goal statement that the milestone replaces fake lifecycle behavior.
  - Start launches a real local child process: covered by focused unit tests for adapter start pid/status and lifecycle start wiring, plus the browser lifecycle Start path in `tests/e2e/root-route.spec.ts:604`.
  - Stop terminates the tracked local process: covered by focused unit tests for adapter stop and the browser Stop path in `tests/e2e/root-route.spec.ts:604`.
  - stdout/stderr lines persist and are visible in dashboard/detail experience: covered by focused unit tests, `tests/e2e/root-route.spec.ts:53`, and `tests/e2e/root-route.spec.ts:1312`.
  - Forced dummy runner crash changes status to `error` and records an audit event: covered by `tests/unit/create-agent-db.test.ts` crash coverage in the focused unit suite.
  - Existing lifecycle controls and status pills remain the dashboard control model: covered by `tests/unit/root-page.test.tsx` and `tests/e2e/root-route.spec.ts:604`.
  - Aggregate validation passes against a migrated local database: final `bun run verify` passed against the reset and migrated `agentbay_issue_75-postgres` database.

#### #74

- Date: 2026-07-04
- Environment:
  - Isolated database target: container `agentbay_issue_74-postgres` on host port `54374`, `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54374/agentbay`.
  - Isolated app/test server target: `PORT=3074`, `PLAYWRIGHT_BASE_URL=http://localhost:3074`, `NEXT_PUBLIC_APP_URL=http://localhost:3074`.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile because this worktree initially had no `node_modules`.
  - `docker info --format '{{.ServerVersion}}'`: pass; Docker daemon reachable with server version `29.3.1`.
  - `docker ps -a --filter name=agentbay_issue_74 --format '{{.Names}} {{.Status}} {{.Ports}}'`: pass; no existing #74 container was present before setup.
  - `docker run --name agentbay_issue_74-postgres -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54374:5432 -d postgres:17-alpine`: pass; started isolated Postgres for #74.
  - `docker exec agentbay_issue_74-postgres pg_isready -U agentbay -d agentbay`: pass; Postgres accepted connections.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54374/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3074 bun run db:migrate`: pass; migrations applied successfully.
- Focused checks:
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54374/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3074 bun run test -- tests/unit/create-agent-db.test.ts`: pass; 82 tests passed, including local runner lifecycle start/stop/restart, invalid action no-mutation behavior, persisted logs, and lifecycle-launched crash-to-error audit coverage.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54374/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3074 bun run test -- tests/unit/start-agent-route.test.ts tests/unit/stop-agent-route.test.ts tests/unit/restart-agent-route.test.ts tests/unit/local-runner-adapter.test.ts`: pass; 4 files and 7 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54374/agentbay PORT=3074 PLAYWRIGHT_BASE_URL=http://localhost:3074 NEXT_PUBLIC_APP_URL=http://localhost:3074 bun run test:e2e -- --project=chromium-desktop --grep "creates Research Agent"`: pass; dashboard/detail start, restart, stop, activity, and delete flow passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54374/agentbay PORT=3074 PLAYWRIGHT_BASE_URL=http://localhost:3074 NEXT_PUBLIC_APP_URL=http://localhost:3074 bun run test:e2e -- --project=chromium-desktop --grep "scoped runtime logs"`: pass; agent detail showed lifecycle-launched dummy stdout/stderr logs and stopped polling after stop.
- Required gates:
  - `bun run format:check`: pass; Biome checked 83 files.
  - `bun run lint`: pass; Biome checked 83 files.
  - `bun run typecheck`: pass; `tsc --noEmit` passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54374/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3074 bun run test`: pass; 23 files and 204 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54374/agentbay PORT=3074 PLAYWRIGHT_BASE_URL=http://localhost:3074 NEXT_PUBLIC_APP_URL=http://localhost:3074 bun run build`: pass; Next.js production build completed and included lifecycle action routes, dashboard, agent detail, logs, approvals, health, and settings routes.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54374/agentbay PORT=3074 PLAYWRIGHT_BASE_URL=http://localhost:3074 NEXT_PUBLIC_APP_URL=http://localhost:3074 bun run test:e2e`: pass; full browser suite passed with 38 tests and 18 expected skips.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54374/agentbay PORT=3074 PLAYWRIGHT_BASE_URL=http://localhost:3074 NEXT_PUBLIC_APP_URL=http://localhost:3074 bun run verify`: pass; aggregate format, lint, typecheck, unit test, production build, and Playwright gates passed with 204 unit tests and 38 E2E passed / 18 expected skips.

#### #72

- Date: 2026-07-04
- Environment:
  - Isolated database target: container `agentbay_issue_72-postgres` on host port `54372`, `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54372/agentbay`.
  - Isolated app/test server target: `PORT=3072`, `PLAYWRIGHT_BASE_URL=http://localhost:3072`, `NEXT_PUBLIC_APP_URL=http://localhost:3072`.
- Setup:
  - `test -d node_modules && echo node_modules-present || echo node_modules-missing`: pass; reported `node_modules-missing` before setup.
  - `bun install --frozen-lockfile`: pass; installed committed lockfile dependencies.
  - `docker info --format '{{.ServerVersion}}'`: pass; Docker daemon reachable with server version `29.3.1`.
  - `docker ps -a --filter name=agentbay_issue_72-postgres --format '{{.Names}} {{.Status}} {{.Ports}}'`: pass; no existing #72 container was present before setup.
  - `docker run --name agentbay_issue_72-postgres -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54372:5432 -d postgres:17-alpine`: pass; started isolated Postgres for #72.
  - `docker exec agentbay_issue_72-postgres pg_isready -U agentbay -d agentbay`: pass; Postgres accepted connections.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54372/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3072 bun run db:migrate`: pass; migrations applied successfully against the isolated #72 database.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54372/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3072 bun run db:health`: pass; returned `status: ok` and `database: reachable`.
- Focused checks:
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54372/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3072 bun run test -- tests/unit/local-runner-adapter.test.ts tests/unit/create-agent-db.test.ts`: pass; 2 files and 79 tests passed, including adapter command configuration, safe executable/argv spawning with `shell: false`, real dummy child start/status/stop, stdout/stderr persistence, restart process-log separation, unexpected-exit terminal state, and a cross-agent process-id log streaming regression.
- Required gates:
  - `bun run format:check`: pass; Biome checked 83 files.
  - `bun run lint`: pass; Biome checked 83 files.
  - `bun run typecheck`: pass; `tsc --noEmit` passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54372/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3072 bun run test`: pass; 23 files and 197 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54372/agentbay PORT=3072 PLAYWRIGHT_BASE_URL=http://localhost:3072 NEXT_PUBLIC_APP_URL=http://localhost:3072 bun run build`: pass; Next.js build completed and included dashboard, agent detail, lifecycle, approval decision, log, health, and settings routes.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54372/agentbay PORT=3072 PLAYWRIGHT_BASE_URL=http://localhost:3072 NEXT_PUBLIC_APP_URL=http://localhost:3072 bun run verify`: pass; aggregate format, lint, typecheck, unit test, production build, and Playwright gates passed with 197 unit tests and 37 E2E passed / 17 expected skips.
- Reconciliation:
  - A concurrent `bun run test:e2e` and `bun run verify` attempt against the same #72 database failed with Postgres deadlocks and polluted E2E assertions. This was an invalid validation setup caused by running two DB-mutating suites in parallel. Rerunning `bun run verify` alone against the same isolated #72 database passed.
  - Checker found that process-id log streaming trusted `processId` without proving ownership. `listLocalRunnerProcessLogs` now requires `agentId` and joins `agent_logs`, `local_runner_processes`, and `agents` against the active development user; the adapter passes the requested agent id into that helper. The new two-agent regression proves `adapter.streamLogs({ agentId: agentA.id, processId: processB.id })` returns an empty page and does not expose agent B's log.
  - Maintainer review found that `LocalRunnerAdapter.start()` left a spawned child alive if durable state persistence threw before the process row was recorded. `start()` now retains the spawned child reference and runs bounded SIGTERM/SIGKILL cleanup before returning `state_persistence_failed`, with defensive no-throw behavior if the child already exited or `kill` throws.
  - Maintainer-fix focused validation:
    - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54372/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3072 bun run db:migrate`: pass; migrations were already applied successfully.
    - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54372/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3072 bun test tests/unit/create-agent-db.test.ts --test-name-pattern "local runner adapter"`: pass; 8 tests passed including the new spawned-child cleanup regression and cleanup-throws regression.
    - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54372/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3072 bun run format:check`: pass; Biome checked 83 files.
    - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54372/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3072 bun run lint`: pass; Biome checked 83 files.
    - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54372/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3072 bun run typecheck`: pass; `tsc --noEmit` passed.
    - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54372/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3072 bun run verify`: failed twice in the existing Playwright E2E test `tests/e2e/root-route.spec.ts:471` because `page.getByRole("status")` resolved both the action message `Start requested.` and the latest-log loading status. Both runs passed format, lint, typecheck, 23 Vitest files / 199 tests, and production build before the unrelated E2E failure.
    - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54372/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3072 bun run test:e2e tests/e2e/root-route.spec.ts:471 --project chromium-desktop`: pass; the exact failed Playwright case passed standalone.

#### #73

- Date: 2026-07-04
- Environment:
  - Isolated database target: container `agentbay_issue_73-postgres` on host port `54373`, `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54373/agentbay`.
  - Isolated app/test server target: `PORT=3073`, `PLAYWRIGHT_BASE_URL=http://localhost:3073`, `NEXT_PUBLIC_APP_URL=http://localhost:3073`.
- Setup:
  - `test -d node_modules && echo node_modules-present || echo node_modules-missing`: pass; reported `node_modules-missing` before setup.
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile.
  - `docker info --format '{{.ServerVersion}}'`: pass; Docker daemon reachable with server version `29.3.1`.
  - `docker ps -a --filter name=agentbay_issue_73-postgres --format '{{.Names}} {{.Status}} {{.Ports}}'`: pass; no existing #73 container was present before setup.
  - `docker run --name agentbay_issue_73-postgres -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54373:5432 -d postgres:17-alpine`: pass; started isolated Postgres for #73.
  - `docker exec agentbay_issue_73-postgres pg_isready -U agentbay -d agentbay`: pass; Postgres accepted connections.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54373/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3073 bun run db:migrate`: pass; migrations applied successfully.
- Implementation checks:
  - `bun run format`: pass; Biome formatted 81 files after edits.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54373/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3073 bun run test -- tests/unit/agent-logs-route.test.ts tests/unit/root-page.test.tsx tests/unit/create-agent-db.test.ts`: pass after one expectation-only retry; final focused route/dashboard/DB suite passed with 3 files and 113 tests.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54373/agentbay PORT=3073 PLAYWRIGHT_BASE_URL=http://localhost:3073 NEXT_PUBLIC_APP_URL=http://localhost:3073 bun run test:e2e -- --project=chromium-desktop --grep "dashboard shows latest persisted process logs"`: pass after scoping duplicate-agent-link assertions to individual log rows; 1 browser test passed.
- Checker fix:
  - Finding: checker probe confirmed `GET /api/agents/:agentId/logs` returned `runnerId` and `localRunnerProcessId` for persisted local-runner log rows.
  - Fix: `app/api/agents/[agentId]/logs/route.ts` now maps internal `AgentLogPage` values to a public response that keeps `id`, `agentId`, `stream`, `level`, `message`, `sequence`, and `createdAt`, and omits runner/process identifiers.
  - Regression: `tests/unit/agent-logs-route.test.ts` now seeds internal runner/process ids and asserts the route response omits them while preserving stdout/stderr order and agent scoping; `tests/e2e/root-route.spec.ts` now calls the product route against seeded process logs and asserts those fields are absent.
  - `bun run format`: pass; Biome formatted 81 files after the checker fix.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54373/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3073 bun run test -- tests/unit/agent-logs-route.test.ts tests/unit/root-page.test.tsx tests/unit/create-agent-db.test.ts`: pass; 3 files and 114 tests passed.
  - `bun run typecheck`: pass; `tsc --noEmit` completed successfully.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54373/agentbay PORT=3073 PLAYWRIGHT_BASE_URL=http://localhost:3073 NEXT_PUBLIC_APP_URL=http://localhost:3073 bun run test:e2e -- --project=chromium-desktop --grep "dashboard shows latest persisted process logs"`: pass; 1 chromium-desktop browser test passed.
  - `bun run format:check`: pass; Biome checked 81 files.
  - `bun run lint`: pass; Biome checked 81 files.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54373/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3073 bun run test`: pass; 22 files and 194 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54373/agentbay PORT=3073 PLAYWRIGHT_BASE_URL=http://localhost:3073 NEXT_PUBLIC_APP_URL=http://localhost:3073 bun run build`: pass; Next.js production build completed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54373/agentbay PORT=3073 PLAYWRIGHT_BASE_URL=http://localhost:3073 NEXT_PUBLIC_APP_URL=http://localhost:3073 bun run test:e2e`: pass; full browser suite passed with 38 tests and 18 expected skips.
- Maintainer-review fix:
  - Finding: maintainer review on PR #112 found that `GET /api/agents/:agentId/logs` stripped process ids but still returned raw persisted `message` content, including token-like text.
  - Fix: `app/api/agents/[agentId]/logs/route.ts` now sanitizes public `message` values with `summarizeOperationalText` before returning JSON.
  - Regression: `tests/unit/agent-logs-route.test.ts` now asserts token-like messages become `Sensitive details omitted.`, Postgres URLs are redacted, stack-frame paths are omitted, and raw token/URL/path content is absent. `tests/e2e/root-route.spec.ts` applies the same assertions to the seeded product route plus dashboard rendering while preserving ordering and per-agent scoping.
  - `bun run format`: pass; Biome formatted 81 files and fixed 1 test file.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54373/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3073 bun run test -- tests/unit/agent-logs-route.test.ts tests/unit/root-page.test.tsx tests/unit/create-agent-db.test.ts tests/unit/operational-summaries.test.ts`: pass; 4 files and 117 tests passed.
  - `bun run typecheck`: pass; `tsc --noEmit` completed successfully.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54373/agentbay PORT=3073 PLAYWRIGHT_BASE_URL=http://localhost:3073 NEXT_PUBLIC_APP_URL=http://localhost:3073 bun run test:e2e -- --project=chromium-desktop --grep "dashboard shows latest persisted process logs"`: pass; 1 chromium-desktop browser test passed.
  - `bun run format:check`: pass; Biome checked 81 files.
  - `bun run lint`: pass; Biome checked 81 files.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54373/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3073 bun run test`: pass; 22 files and 194 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54373/agentbay PORT=3073 PLAYWRIGHT_BASE_URL=http://localhost:3073 NEXT_PUBLIC_APP_URL=http://localhost:3073 bun run build`: pass; Next.js production build completed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54373/agentbay PORT=3073 PLAYWRIGHT_BASE_URL=http://localhost:3073 NEXT_PUBLIC_APP_URL=http://localhost:3073 bun run test:e2e`: pass; full browser suite passed with 38 tests and 18 expected skips.
- Required gates:
  - `bun run format:check`: pass; Biome checked 81 files.
  - `bun run lint`: pass; Biome checked 81 files.
  - `bun run typecheck`: pass; `tsc --noEmit` completed successfully.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54373/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3073 bun run test`: pass; 22 files and 193 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54373/agentbay PORT=3073 PLAYWRIGHT_BASE_URL=http://localhost:3073 NEXT_PUBLIC_APP_URL=http://localhost:3073 bun run build`: pass; Next.js production build completed and included dashboard, agent detail, lifecycle, approval, log, health, and settings routes.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54373/agentbay PORT=3073 PLAYWRIGHT_BASE_URL=http://localhost:3073 NEXT_PUBLIC_APP_URL=http://localhost:3073 bun run test:e2e`: pass; full browser suite passed with 38 tests and 18 expected skips.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54373/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3073 bun run db:health`: pass; returned `status: ok` and `database: reachable`.
#### #71

- Date: 2026-07-04
- Environment:
  - Isolated database target: container `agentbay_issue_71-postgres` on host port `54371`, `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54371/agentbay`.
  - Isolated app/test server target: `PORT=3071`, `PLAYWRIGHT_BASE_URL=http://localhost:3071`, `NEXT_PUBLIC_APP_URL=http://localhost:3071`.
- Setup:
  - `test -d node_modules && echo node_modules-present || echo node_modules-missing`: pass; reported `node_modules-missing` before baseline setup.
  - `bun install --frozen-lockfile`: pass; installed the committed lockfile dependencies.
  - `docker info --format '{{.ServerVersion}}'`: pass; Docker daemon reachable with server version `29.3.1`.
  - `docker ps -a --filter name=agentbay_issue_71-postgres --format '{{.Names}} {{.Status}} {{.Ports}}'`: pass; no existing #71 container was present before setup.
  - `docker run --name agentbay_issue_71-postgres -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54371:5432 -d postgres:17-alpine`: pass; started isolated Postgres for #71.
  - `docker exec agentbay_issue_71-postgres pg_isready -U agentbay -d agentbay`: pass; Postgres accepted connections.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54371/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3071 bun run db:migrate`: pass; migrations applied successfully against the isolated #71 database.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54371/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3071 bun run db:health`: pass; returned `status: ok` and `database: reachable`.
- Baseline checks:
  - `bun run format:check`: pass; Biome checked 78 files.
  - `bun run lint`: pass; Biome checked 78 files.
  - `bun run typecheck`: pass; `tsc --noEmit` completed successfully.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54371/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3071 bun run test`: pass; 21 files and 177 tests passed.
- Changelog structure:
  - `rg -n "^# Changelog|Keep a Changelog|Semantic Versioning|^## \\[Unreleased\\]|^### (Added|Changed|Deprecated|Removed|Fixed|Security)$" CHANGELOG.md`: pass; `CHANGELOG.md` has top-level `# Changelog`, Keep a Changelog/Semantic Versioning framing, `## [Unreleased]`, and current `### Added` and `### Fixed` sections. Existing entries were preserved.
- Implementation checks:
  - `bun run db:generate`: pass; generated the additive local runner state migration, then the SQL file was renamed to `drizzle/0005_local_runner_state.sql` and Drizzle journal tag updated to match.
  - `bun run format`: pass; Biome formatted 79 files and fixed edited files.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54371/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3071 bun run db:migrate`: pass; applied the new additive migration to the isolated #71 database after expected existing-schema/table notices.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54371/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3071 bun run test -- tests/unit/agent-schema.test.ts tests/unit/create-agent-db.test.ts tests/unit/agent-logs-route.test.ts`: pass; final focused #71 suite passed with 3 files and 101 tests after command metadata redaction, same-agent multi-process sequence, and terminal-status consistency coverage.
  - `bun run format:check`: pass; Biome checked 79 files.
  - `bun run lint`: pass; Biome checked 79 files.
  - `bun run typecheck`: pass; `tsc --noEmit` completed successfully.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54371/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3071 bun run test`: pass; 21 files and 186 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54371/agentbay PORT=3071 PLAYWRIGHT_BASE_URL=http://localhost:3071 NEXT_PUBLIC_APP_URL=http://localhost:3071 bun run verify`: pass; aggregate format, lint, typecheck, unit test, production build, and Playwright gates passed with 186 unit tests and 37 E2E passed / 17 expected skips.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54371/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3071 bun run db:health`: pass; returned `status: ok` and `database: reachable` after the new migration.

## Milestone 10 Dockerized Agent Runner Gate Classification

- Status: complete for #76/#77/#78/#79/#80/#81; Milestone 10 is ready for checker review.
- Source plan: `docs/MILESTONES.md` Milestone 10
- Tracking issues: #76-#81
- Current branch: `codex/issue-81-docker-acceptance`
- Next step: checker should review the final real-Docker acceptance smoke, Milestone 10 completion marker, cleanup behavior, and gate evidence below.

### Issue Checklist

- [x] #76 Classify Docker runner quality gates
- [x] #77 Persist Docker runtime metadata and agent logs
- [x] #78 Add the Docker runner adapter
- [x] #79 Run lifecycle controls through Docker containers
- [x] #80 Detect Docker crashes and clean up selected-agent containers
- [x] #81 Verify Docker runner milestone acceptance
- Later Milestone 10 issue agents must append new issue rows here before implementation evidence if GitHub adds more Milestone 10 work.

### Current Status

- #76 initializes Milestone 10 tracking and records the baseline quality gates against an isolated Postgres service on host port `54376` and app port `3076`.
- #76 adds `tests/helpers/docker-availability.ts` so future real-Docker tests can distinguish missing Docker tooling or daemon availability from product failures.
- #76 adds deterministic unit coverage for Docker availability classification by injecting fake Docker info runners; the normal unit suite does not require Docker.
- #76 does not add a dedicated Docker test package script. Future real-Docker test slices should add one only when there are real Docker tests to run, then record the command here.
- #76 leaves `CHANGELOG.md` unchanged because this is tracking and quality-gate setup only, with no user/operator-visible product behavior shipped.
- #76 does not change schema, migrations, runtime metadata tables, log persistence, dependencies, lockfiles, Docker runner behavior, lifecycle controls, container crash detection, selected-agent containers, provider integrations, auth, billing, or secrets.
- #77 adds the additive `docker_runner_containers` table for selected active agents with exact container ID, container name, image, observed status, observed/start/finish timestamps, and sanitized metadata.
- #77 extends durable `agent_logs` with `source`, `metadata`, and optional `docker_runner_container_id` so simulator, local-runner, and future Docker logs can share the same agent-scoped ordered read path.
- #77 adds Docker runner state helpers for recording observed container metadata, appending stdout/stderr Docker log rows, and reading logs only when the requested active development-user agent and exact container ID both match.
- #77 updates the product log route and agent detail log panel to use a safe public log DTO: `source`, `stream`, `level`, sanitized `message`, `sequence`, and `createdAt`; log-row, agent, runner, local process, Docker container, and raw metadata identifiers stay server-side.
- #77 does not start Docker containers, add a Docker adapter, wire lifecycle controls through Docker, detect crashes, clean up containers, implement #74 lifecycle endpoint behavior, or complete Milestone 10 acceptance.
- #78 adds a generic server runner adapter contract for `start`, `stop`, `restart`, `status`, and log streaming while preserving the existing local runner adapter result shape for current lifecycle flows.
- #78 adds `DockerRunnerAdapter`, which runs Docker CLI commands through executable plus argument arrays, defaults to a deterministic dummy BusyBox runner command, and accepts explicit image/argv configuration without real Hermes.
- #78 `docker run` creates a unique AgentBay container name, applies `agentbay.agent_id=<agentId>`, mounts per-agent mutable workspace storage, mounts config read-only when configured, sets `AGENTBAY_AGENT_ID`/workspace/config env vars, and applies initial CPU/memory limits.
- #78 stop, status, restart, log streaming, and start-failure cleanup target the exact stored Docker container ID and validate the expected `agentbay.agent_id` label before Docker mutation or log persistence.
- #78 log streaming reads `docker logs --timestamps` for the exact validated container, parses stdout/stderr timestamped lines, persists Docker log rows once, and returns container-scoped logs without exposing another agent's container rows.
- #78 real Docker contract coverage uses the #76 Docker availability helper and skips with a clear reason when Docker or the fixture image is unavailable.
- #78 does not wire product lifecycle endpoints/UI through Docker, detect Docker crashes, reconcile deleted containers, complete Milestone 10 acceptance, or add cloud/auth/billing/Hermes/Telegram/provider integrations.
- #79 wires the existing Start/Stop/Restart API routes and dashboard/detail/mobile lifecycle controls through the Docker runner adapter without changing the public control model.
- #79 start creates one selected-agent Docker container, persists `running` only after Docker start/inspect/state persistence succeeds, and records requested/completed lifecycle events with safe Docker container metadata.
- #79 stop targets only the selected agent's stored Docker container, validates the container label through the adapter, persists `stopped`, and records requested/completed events with the stopped container metadata.
- #79 restart stops the selected agent's stored Docker container, starts a replacement selected-agent container, leaves the agent `running`, and records requested/completed events with the replacement container metadata.
- #79 start and restart now reject a newly created Docker container unless inspect reports `State.Status === "running"`; any restart replacement-start failure after the old selected container is stopped moves the agent to `stopped` instead of leaving stale `running`.
- #79 product log reads now poll the lifecycle runner for running agents so Docker stdout/stderr lines are captured into `agent_logs`, and dashboard/detail log surfaces include Docker-sourced rows without exposing internal runner/container identifiers.
- #79 keeps validation, not-found, invalid-status, safe error responses, local runner adapter tests, crash reconciliation, deleted-agent cleanup, cloud/auth/billing/Hermes/Telegram/provider work, and dependency changes out of scope.
- #80 extends Docker inspect persistence with sanitized Docker state metadata including observed status, exit code, OOM flag, and timestamps.
- #80 adds bounded Docker reconciliation on active-agent list/detail reads so a stale `running` selected-agent container that exits unexpectedly is moved to `error`.
- #80 crash reconciliation writes one `agent.error` audit event and one visible stderr Docker system log with safe Docker status/exit metadata, without exposing raw Docker error text or secrets.
- #80 adds selected-agent Docker cleanup that validates the exact stored container ID and expected `agentbay.agent_id` label before `docker rm --force`; no-container cleanup is a no-op, and label/inspect/remove failures fail closed.
- #80 wires delete through selected-agent Docker cleanup before soft deletion, while preserving #79 product start/stop/restart Docker lifecycle wiring.
- #80 treats selected-agent containers that already exited with code `0` as clean stop targets, so intentional Docker stops do not become false crash reconciliation or stop-failure states.
- #80 regression coverage proves one agent's Docker crash or cleanup does not change another agent's container, status, events, or logs.
- #81 adds a final real-Docker Playwright acceptance smoke that drives product APIs, verifies exact Docker labels/statuses, proves selected-agent start/restart/stop/log/crash/delete cleanup isolation with a sibling agent still running, and exercises delete fail-closed behavior with a mismatched stored container target.
- #81 fixes a Docker target-selection bug found by the final smoke: unqualified lifecycle/maintenance operations now prefer a selected-agent `running` Docker row before falling back to the latest observed row, so stop/restart/cleanup do not target an older cleanly exited container while a replacement is still running.
- #81 updates shared E2E teardown to remove labeled AgentBay Docker containers for tracked test agents with verified cleanup, plus an orphaned non-running container safety net for labeled containers whose agent rows are already gone; final validation confirmed no labeled AgentBay Docker containers remained after full verify.
- #81 marks Milestone 10 completed in `docs/MILESTONES.md`.
- #81 keeps `CHANGELOG.md` and README unchanged because it adds final validation/tracking coverage only; the shipped Docker behavior already has qualifying changelog entries and Docker/E2E prerequisites are already discoverable.

### Final Acceptance Checklist

- [x] Start creates one selected-agent Docker container: the #81 real-Docker smoke starts primary and sibling agents through product APIs, checks exactly one labeled container for each selected agent after start, and validates the Docker `agentbay.agent_id` label plus `running` status.
- [x] Stop targets only the selected container: the #81 smoke stops the primary agent, verifies the primary replacement container is `exited`, and verifies the sibling container remains the same `running` container.
- [x] Restart targets only the selected container: the #81 smoke restarts the primary agent, verifies the primary container ID changes to a new `running` selected-agent container, and verifies the sibling container remains unchanged and `running`.
- [x] Logs remain isolated by agent: the #81 smoke reads `GET /api/agents/:agentId/logs?limit=100` for primary and sibling agents, checks each Docker dummy-runner line contains only its own agent ID, and rejects the other agent ID in each response.
- [x] Crash changes status to `error`: the #81 smoke kills the selected primary container with Docker, reads the product agent detail route to trigger reconciliation, and polls persisted status until it becomes `error` with a Docker crash log.
- [x] Cleanup removes only the selected exact container: the #81 smoke deletes the errored primary through `DELETE /api/agents/:agentId`, verifies the primary crash container is removed, and verifies the sibling container still exists and is `running`.
- [x] Cleanup fails closed: the #81 smoke creates a tampered stored-container target pointing at the sibling's real container, calls `DELETE /api/agents/:agentId`, verifies the safe `agent_delete_failed` response, confirms the tampered agent is not soft-deleted, and confirms both real containers still exist.
- [x] Real Docker was available: `docker info --format '{{.ServerVersion}}'` returned `29.3.1`, and the final smoke used the real `busybox:1.36` Docker runner fixture rather than skipping.
- [x] Final quality gates passed against the isolated #81 database/app ports, and `bun run verify` passed after the new coverage was added.
- [x] `CHANGELOG.md` has no #81 validation-only noise; existing Milestone 10 Docker behavior entries remain under `[Unreleased]`.
- [x] README/focused docs required no change because Docker prerequisites and E2E/local validation commands are already documented.

### Update Log Requirements

- Each Milestone 10 issue agent must update this section with issue status, branch, implementation evidence, validation commands, skipped checks, blockers, and handoff notes.
- Docker-dependent test evidence must record Docker availability separately from product assertions. Docker-unavailable runs may skip real Docker tests only through the helper or a documented pattern with the exact skip reason.
- Non-Docker gates must still run when Docker is unavailable unless the failing command itself requires Docker or a reachable database.
- `CHANGELOG.md` should receive Milestone 10 entries only for shipped user/operator-visible commands or behavior, not for tracking-only or gate-classification updates.

### Docker Availability Test Pattern

- Use `detectDockerAvailability` from `tests/helpers/docker-availability.ts` before real Docker tests that start containers or inspect Docker state.
- Use `dockerUnavailableSkipReason` to report a clear skip reason such as `Skipping real Docker tests: Docker daemon is not reachable.` when Docker is unavailable.
- Keep helper tests deterministic by injecting a `DockerInfoRunner`; do not make normal unit tests depend on the local Docker daemon.
- When a future slice adds real Docker tests, group them behind this availability check and record whether they ran or skipped in this Milestone 10 progress section.

### Validation

#### #81

- Date: 2026-07-05
- Environment:
  - Docker daemon: reachable; `docker info --format '{{.ServerVersion}}'` returned `29.3.1`.
  - Isolated database: container `agentbay_issue_81-postgres`, host port `54381`, `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54381/agentbay`.
  - Isolated app/test server: `PORT=3081`, `PLAYWRIGHT_BASE_URL=http://localhost:3081`, `NEXT_PUBLIC_APP_URL=http://localhost:3081`.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed committed dependencies in the #81 worktree.
  - `docker ps -a --filter name=agentbay_issue_81-postgres --format '{{.Names}} {{.Status}} {{.Ports}}'`: pass; no existing #81 Postgres container was present before setup.
  - `docker ps -a --filter label=agentbay.agent_id --format '{{.ID}} {{.Names}} {{.Labels}}'`: pass; no labeled AgentBay containers were present before setup.
  - `docker run --name agentbay_issue_81-postgres -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54381:5432 -d postgres:17-alpine`: pass; started isolated Postgres for #81.
  - `docker exec agentbay_issue_81-postgres pg_isready -U agentbay -d agentbay`: pass; Postgres accepted connections.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54381/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3081 bun run db:migrate`: pass; migrations applied successfully. Postgres emitted the expected notice that Drizzle's long Docker FK identifier was truncated.
- Focused acceptance smoke:
  - First run of `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54381/agentbay PORT=3081 PLAYWRIGHT_BASE_URL=http://localhost:3081 NEXT_PUBLIC_APP_URL=http://localhost:3081 bun run test:e2e -- tests/e2e/root-route.spec.ts --project=chromium-desktop --grep "Docker runner final acceptance" --workers=1`: failed in the test tamper helper because deleting a Docker metadata row violated the expected `agent_logs` FK. Product behavior was not implicated; the helper now detaches the sibling DB row to a synthetic ID before pointing the tampered agent at the sibling's real container.
  - After resetting the #81 DB and cleaning labeled containers, `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54381/agentbay PORT=3081 PLAYWRIGHT_BASE_URL=http://localhost:3081 NEXT_PUBLIC_APP_URL=http://localhost:3081 bun run test:e2e -- tests/e2e/root-route.spec.ts --project=chromium-desktop --grep "Docker runner final acceptance" --workers=1`: pass; 1 Chromium desktop test passed and covered selected-agent start, restart, stop, logs, real Docker crash reconciliation, delete cleanup, sibling-container isolation, and fail-closed cleanup.
- Checker-fix product regression:
  - Focused `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54381/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3081 bun run test -- tests/unit/create-agent-db.test.ts -t "docker runner adapter stops the running replacement"`: pass; proves `DockerRunnerAdapter.stop()` targets an older `running` replacement row even when an exited row has a newer `observedAt`.
- Required gates:
  - `bun run format:check`: pass; Biome checked 89 files.
  - `bun run lint`: pass; Biome checked 89 files.
  - `bun run typecheck`: pass; `tsc --noEmit` passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54381/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3081 bun run test`: pass; 24 files and 224 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54381/agentbay PORT=3081 PLAYWRIGHT_BASE_URL=http://localhost:3081 NEXT_PUBLIC_APP_URL=http://localhost:3081 bun run build`: pass; Next.js production build completed and included dashboard, agent detail, lifecycle actions, logs, approvals, health, and settings routes.
  - After resetting the #81 DB and cleaning labeled containers, `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54381/agentbay PORT=3081 PLAYWRIGHT_BASE_URL=http://localhost:3081 NEXT_PUBLIC_APP_URL=http://localhost:3081 bun run test:e2e`: pass; full browser suite passed with 39 tests and 19 expected skips.
  - After resetting the #81 DB and cleaning labeled containers, `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54381/agentbay PORT=3081 PLAYWRIGHT_BASE_URL=http://localhost:3081 NEXT_PUBLIC_APP_URL=http://localhost:3081 bun run verify`: pass; aggregate format, lint, typecheck, unit test, production build, and Playwright gates passed with 224 unit tests and 39 E2E passed / 19 expected skips.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54381/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3081 bun run db:health`: pass; returned `status: ok` and `database: reachable`.
  - Final cleanup: immediate `docker ps -a --filter label=agentbay.agent_id --format '{{.ID}} {{.Names}} {{.Status}} {{.Labels}}'`: pass; returned no rows after full verify.
  - Delayed cleanup recheck: `sleep 20; docker ps -a --filter label=agentbay.agent_id --format '{{.ID}} {{.Names}} {{.Status}} {{.Labels}}'`: pass; returned no rows.
- Acceptance evidence map:
  - Start creates one selected-agent Docker container: `tests/e2e/root-route.spec.ts` final acceptance smoke starts primary/sibling agents through product APIs, counts one labeled container per agent, and inspects exact Docker labels/statuses.
  - Stop targets only that container: the smoke stops the primary, checks the selected primary container is `exited`, and verifies the sibling container remains running.
  - Restart targets only that container: the smoke restarts the primary, verifies a new primary container ID, and verifies the sibling container remains unchanged.
  - Logs remain isolated by agent: the smoke reads product log APIs for each agent and asserts each log body contains only that agent's Docker dummy-runner ID line.
  - Crash changes status to `error`: the smoke kills the selected primary container, triggers product detail reconciliation, polls status to `error`, and verifies the Docker crash log.
  - Cleanup removes only the selected exact container and fails closed: the smoke deletes the crashed primary and proves the sibling remains running; then it tampers a stored container target, verifies delete returns safe `agent_delete_failed`, the tampered agent remains active, and both involved real containers remain.
  - Cleanup hygiene: E2E teardown now removes labeled Docker containers for tracked test agents, verifies exact-ID/label cleanup, removes orphaned non-running labeled containers for agents already absent from the DB, and both immediate and delayed post-verify Docker label checks returned no rows.
- Changelog/docs scope:
  - `CHANGELOG.md` intentionally unchanged for #81 because this issue adds final validation coverage/tracking only; Docker runner behavior entries already exist from #77-#80.
  - README intentionally unchanged because Docker is already listed as a prerequisite and E2E/local validation commands are documented.

#### #79

- Date: 2026-07-05
- Environment:
  - Docker daemon: reachable; `docker info --format '{{.ServerVersion}}'` returned `29.3.1`.
  - Isolated database: container `agentbay_issue_79-postgres`, host port `54379`, `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54379/agentbay`.
  - Isolated app/test server: `PORT=3079`, `PLAYWRIGHT_BASE_URL=http://localhost:3079`, `NEXT_PUBLIC_APP_URL=http://localhost:3079`.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile because this worktree initially had no `node_modules`.
  - `docker ps -a --filter name=agentbay_issue_79-postgres --format '{{.Names}} {{.Status}} {{.Ports}}'`: pass; no existing #79 Postgres container was present before setup.
  - `docker run --name agentbay_issue_79-postgres -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54379:5432 -d postgres:17-alpine`: pass; started isolated Postgres for #79.
  - `docker exec agentbay_issue_79-postgres pg_isready -U agentbay -d agentbay`: pass; Postgres accepted connections.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54379/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3079 bun run db:migrate`: pass; migrations applied successfully. Postgres emitted the expected notice that Drizzle's long Docker FK identifier was truncated.
- Focused checks:
  - Maintainer-fix regression: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54379/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3079 bun run test -- tests/unit/create-agent-db.test.ts`: pass; 1 file and 92 tests passed, including fast-exit Docker start/restart regressions plus a `docker_run_failed` restart replacement regression after the old selected container stops.
  - Maintainer-fix quality checks: `bun run format`: pass; Biome formatted 88 files and fixed 1 lifecycle file. `bun run format:check`: pass; Biome checked 88 files. `bun run lint`: pass; Biome checked 88 files. `bun run typecheck`: pass; `tsc --noEmit` passed.
  - Checker-fix regression: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54379/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3079 bun run test -- tests/unit/create-agent-db.test.ts`: pass; 1 file and 91 tests passed, including fast-exit Docker start/restart regressions that reject `exited` inspected containers, remove the failed replacement container, keep start from marking the agent `running`, and move failed restart out of stale `running`.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54379/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3079 bun run test -- tests/unit/create-agent-db.test.ts tests/unit/docker-runner-adapter.test.ts tests/unit/agent-logs-route.test.ts tests/unit/root-page.test.tsx`: pass; 4 files and 132 tests passed, including Docker lifecycle route metadata, Docker adapter behavior, log route streaming, and dashboard copy/rendering.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54379/agentbay PORT=3079 PLAYWRIGHT_BASE_URL=http://localhost:3079 NEXT_PUBLIC_APP_URL=http://localhost:3079 bun run test:e2e -- --project=chromium-desktop --grep "creates Research Agent|scoped runtime logs" --workers=1`: pass after fixing E2E teardown for `docker_runner_containers`; 2 browser tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54379/agentbay PORT=3079 PLAYWRIGHT_BASE_URL=http://localhost:3079 NEXT_PUBLIC_APP_URL=http://localhost:3079 bun run test:e2e -- tests/e2e/root-route.spec.ts:554 --project=chromium-desktop --workers=1`: pass; the dashboard showed Docker logs captured by observing the selected running agent.
- Required gates:
  - `bun run format:check`: pass; Biome checked 88 files.
  - `bun run lint`: pass; Biome checked 88 files.
  - `bun run typecheck`: pass; `tsc --noEmit` passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54379/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3079 bun run test`: pass; 24 files and 214 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54379/agentbay PORT=3079 PLAYWRIGHT_BASE_URL=http://localhost:3079 NEXT_PUBLIC_APP_URL=http://localhost:3079 bun run build`: pass; Next.js production build completed without Turbopack tracing warnings after UUID validation was split out and Docker path tracing was annotated.
  - Maintainer-fix final reset: `docker exec agentbay_issue_79-postgres psql -U agentbay -d agentbay -c 'truncate table agent_approvals, agent_configs, agent_logs, docker_runner_containers, local_runner_processes, agent_events, agents, app_metadata, users restart identity cascade;'`: pass; isolated #79 test database was reset before the aggregate gate.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54379/agentbay PORT=3079 PLAYWRIGHT_BASE_URL=http://localhost:3079 NEXT_PUBLIC_APP_URL=http://localhost:3079 bun run verify`: pass; aggregate format, lint, typecheck, unit test, production build, and Playwright gates passed with 218 unit tests and 38 E2E passed / 18 expected skips.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54379/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3079 bun run db:health`: pass; returned `status: ok` and `database: reachable`.
- Acceptance evidence map:
  - Existing lifecycle controls preserved: dashboard, detail, and mobile controls still call the existing Start/Stop/Restart API routes; `tests/e2e/root-route.spec.ts:600` covers dashboard and detail lifecycle controls through the browser.
  - Start creates exactly one selected-agent Docker container: `tests/unit/create-agent-db.test.ts` route coverage asserts one `docker_runner_containers` row for the started agent and matching start requested/completed Docker metadata.
  - Start rejects fast-exit containers safely: `tests/unit/create-agent-db.test.ts` mocks BusyBox-style `sh -c "printf fast-exit; exit 0"` behavior, asserts `DockerRunnerAdapter.start()` returns `container_not_running`, removes the just-created container, persists no Docker container row, returns lifecycle `runner_start_failed`, writes no start requested/completed events, and leaves the agent `stopped`.
  - Stop targets only the selected agent's stored container: Docker adapter label validation remains covered, and stop route coverage asserts stopped status plus exited selected-container metadata on stop requested/completed events.
  - Restart replaces only the selected agent's stored container: route coverage asserts two selected-agent container rows across start/restart, different exact container IDs, and restart requested/completed metadata for the replacement container.
  - Restart rejects replacement-start failures safely: `tests/unit/create-agent-db.test.ts` proves inspected `exited` replacements and `docker_run_failed` replacements after a successful old-container stop both return lifecycle `runner_restart_failed`, write no restart requested/completed events, keep selected old container metadata as `exited`, and do not leave the agent marked `running`.
  - Docker logs are captured and surfaced: `GET /api/agents/:agentId/logs` streams through the lifecycle runner for running agents, `tests/e2e/root-route.spec.ts:554` proves dashboard latest process logs show captured Docker stdout, and `tests/e2e/root-route.spec.ts:1308` proves detail logs show selected-agent Docker stdout/stderr without internal identifiers.
  - Safe lifecycle behavior preserved: route unit tests still cover validation, not-found, invalid-status, and persistence error responses; invalid lifecycle actions do not call runner helpers or mutate events.
  - Scope boundaries: #79 did not add crash reconciliation, deleted-agent cleanup, cloud/auth/billing/Hermes/Telegram/provider work, dependency changes, or a broad Docker cleanup path.

#### #80

- Date: 2026-07-05
- Environment:
  - Docker daemon: reachable; `docker info --format '{{.ServerVersion}}'` returned `29.3.1`.
  - Isolated database: container `agentbay_issue_80-postgres`, host port `54380`, `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54380/agentbay`.
  - Isolated app/test server target: `PORT=3080`, `PLAYWRIGHT_BASE_URL=http://localhost:3080`, `NEXT_PUBLIC_APP_URL=http://localhost:3080`.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed committed lockfile dependencies because this worktree initially had no `node_modules`.
  - `docker ps -a --filter name=agentbay_issue_80-postgres --format '{{.Names}} {{.Status}} {{.Ports}}'`: pass; no existing #80 Postgres container was present before setup.
  - `docker run --name agentbay_issue_80-postgres -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54380:5432 -d postgres:17-alpine`: pass; started isolated Postgres for #80.
  - `docker exec agentbay_issue_80-postgres pg_isready -U agentbay -d agentbay`: pass; Postgres accepted connections.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54380/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3080 bun run db:migrate`: pass; migrations applied successfully. Postgres emitted the expected notice that Drizzle's long Docker FK identifier was truncated.
- Focused checks:
  - `bun run format`: pass after `bun install`; initial attempt failed with `biome: command not found` because dependencies were not installed in the new worktree.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54380/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3080 bun run test -- tests/unit/create-agent-db.test.ts`: pass; 1 file and 91 tests passed, including Docker crash reconciliation, fail-closed cleanup, exact-label cleanup, cross-agent isolation, and the existing real-Docker adapter contract.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54380/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3080 bun run test -- tests/unit/delete-agent-route.test.ts tests/unit/agent-logs-route.test.ts tests/unit/agent-events-route.test.ts tests/unit/docker-runner-adapter.test.ts`: pass; 4 files and 34 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54380/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3080 bun run test -- tests/unit/create-agent-db.test.ts tests/unit/delete-agent-route.test.ts tests/unit/agent-logs-route.test.ts tests/unit/agent-events-route.test.ts tests/unit/docker-runner-adapter.test.ts`: pass; 5 files and 125 tests passed.
  - Post-#79 rebase regression: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54380/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3080 bun run test -- tests/unit/create-agent-db.test.ts tests/unit/docker-runner-adapter.test.ts`: pass; 2 files and 100 tests passed, including clean zero-exit Docker stop idempotency and clean-exit reconciliation coverage.
  - Post-#79 rebase browser regression: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54380/agentbay PORT=3080 PLAYWRIGHT_BASE_URL=http://localhost:3080 NEXT_PUBLIC_APP_URL=http://localhost:3080 bun run test:e2e -- tests/e2e/root-route.spec.ts:600 --project=chromium-desktop --workers=1`: pass; dashboard/detail Docker Start, Restart, Stop, Simulate error, and Delete flow passed after clean zero-exit stops no longer reconcile as crashes.
  - Post-#79 rebase mobile regression: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54380/agentbay PORT=3080 PLAYWRIGHT_BASE_URL=http://localhost:3080 NEXT_PUBLIC_APP_URL=http://localhost:3080 bun run test:e2e -- tests/e2e/root-route.spec.ts:785 --project=chromium-mobile --workers=1`: pass; mobile Resume and confirmed Stop flow passed.
- Required gates:
  - `bun run format:check`: pass; Biome checked 88 files.
  - `bun run lint`: pass; Biome checked 88 files.
  - `bun run typecheck`: pass; `tsc --noEmit` passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54380/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3080 bun run test`: pass; 24 files and 217 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54380/agentbay PORT=3080 PLAYWRIGHT_BASE_URL=http://localhost:3080 NEXT_PUBLIC_APP_URL=http://localhost:3080 bun run build`: pass; Next.js production build completed without the Docker adapter tracing warning after the lightweight maintenance adapter split.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54380/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3080 bun run db:health`: pass; returned `status: ok` and `database: reachable`.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54380/agentbay PORT=3080 PLAYWRIGHT_BASE_URL=http://localhost:3080 NEXT_PUBLIC_APP_URL=http://localhost:3080 bun run verify`: failed only in Playwright after format, lint, typecheck, unit tests, and build passed; the failing full-concurrency case was `tests/e2e/root-route.spec.ts:1312`, where heartbeat logs pushed the expected startup line out of the latest-six runtime log panel before the assertion.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54380/agentbay PORT=3080 PLAYWRIGHT_BASE_URL=http://localhost:3080 NEXT_PUBLIC_APP_URL=http://localhost:3080 bun run test:e2e -- tests/e2e/root-route.spec.ts:1312 --project=chromium-desktop --workers=1`: pass; exact failed case passed standalone.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54380/agentbay PORT=3080 PLAYWRIGHT_BASE_URL=http://localhost:3080 NEXT_PUBLIC_APP_URL=http://localhost:3080 bun run test:e2e -- --workers=1`: pass; full browser suite passed with 38 tests and 18 expected skips.
  - Post-#79 rebase gate: `bun run format:check && bun run lint && bun run typecheck`: pass; Biome checked 89 files and `tsc --noEmit` passed.
  - Post-#79 rebase final gate: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54380/agentbay PORT=3080 PLAYWRIGHT_BASE_URL=http://localhost:3080 NEXT_PUBLIC_APP_URL=http://localhost:3080 bun run verify`: pass; aggregate format, lint, typecheck, unit test, production build, and Playwright gates passed with 223 unit tests and 38 E2E passed / 18 expected skips.
- Acceptance evidence map:
  - Crash detection: `reconcileDockerRunnerAgentForDevelopmentUser` calls Docker status for the exact stored selected-agent container and marks the active `starting`/`running`/`restarting` agent `error` when Docker reports `exited`/`dead` or a non-zero exit code.
  - Clean intentional exits: Docker stop treats an already `exited` container with exit code `0` as an idempotent stopped target, and crash reconciliation ignores clean zero-exit container observations.
  - Audit trail and visible log: crash reconciliation inserts one `agent.error` event plus one Docker-sourced stderr `agent_logs` row with status, exit code, OOM flag, and finished timestamp metadata.
  - Secret safety: event/log crash metadata omits raw Docker `State.Error`; Docker container metadata still flows through the existing Docker metadata sanitizer.
  - Bounded reconciliation hooks: active-agent list reads reconcile at most 10 Docker-backed transitioning/running agents; active-agent detail reads reconcile only the selected agent before returning status.
  - Cleanup isolation: `DockerRunnerAdapter.cleanup()` resolves the active selected agent's stored container, validates `agentbay.agent_id`, and only then runs `docker rm --force <storedContainerId>`.
  - Fail-closed behavior: label mismatch, inspect failure, and remove failure return cleanup errors without Docker mutation; delete returns a safe failure and does not soft-delete when cleanup fails.
  - Cross-agent regression: unit coverage verifies one agent's crash or cleanup does not mutate another agent's container row, status, events, or logs.
- Coordination notes:
  - #80 was rebased after #79 so product lifecycle wiring remains Docker-backed while read/delete paths add reconciliation and exact-label cleanup.
  - Intentional #79 stop paths leave stopped containers for #80 cleanup/delete reconciliation rather than adding a broad cleanup loop in lifecycle stop.

#### #78

- Date: 2026-07-04
- Environment:
  - Docker daemon: reachable; `docker info --format '{{.ServerVersion}}'` returned `29.3.1`.
  - Isolated database: container `agentbay_issue_78-postgres`, host port `54378`, `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54378/agentbay`.
  - Isolated app/test server: `PORT=3078`, `PLAYWRIGHT_BASE_URL=http://localhost:3078`, `NEXT_PUBLIC_APP_URL=http://localhost:3078`.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile because this worktree initially had no `node_modules`.
  - `docker ps -a --filter name=agentbay_issue_78-postgres --format '{{.Names}} {{.Status}} {{.Ports}}'`: pass; no existing #78 Postgres container was present before setup.
  - `docker run --name agentbay_issue_78-postgres -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54378:5432 -d postgres:17-alpine`: pass; started isolated Postgres for #78.
  - `docker exec agentbay_issue_78-postgres pg_isready -U agentbay -d agentbay`: pass; Postgres accepted connections.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54378/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3078 bun run db:migrate`: pass; migrations applied successfully. Postgres emitted the expected notice that Drizzle's long Docker FK identifier was truncated.
- Focused checks:
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54378/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3078 bun run test -- tests/unit/docker-runner-adapter.test.ts`: pass; 1 file and 3 deterministic command/configuration/availability tests passed without requiring real Docker containers.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54378/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3078 bun run test -- tests/unit/create-agent-db.test.ts tests/unit/docker-runner-adapter.test.ts tests/unit/docker-availability.test.ts`: pass; 3 files and 95 tests passed, including mocked Docker command construction, exact-container label validation, Docker log parsing/persistence, Docker availability helper coverage, and the real Docker adapter contract test.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54378/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3078 bun run test`: pass; 24 files and 214 tests passed.
- Required gates:
  - `bun run format:check`: pass; Biome checked 87 files.
  - `bun run lint`: pass; Biome checked 87 files.
  - `bun run typecheck`: pass; `tsc --noEmit` passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54378/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3078 bun run db:health`: pass; returned `status: ok` and `database: reachable`.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54378/agentbay PORT=3078 PLAYWRIGHT_BASE_URL=http://localhost:3078 NEXT_PUBLIC_APP_URL=http://localhost:3078 bun run build`: pass; Next.js production build completed and included dashboard, agent detail, lifecycle, approval, log, health, and settings routes.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54378/agentbay PORT=3078 PLAYWRIGHT_BASE_URL=http://localhost:3078 NEXT_PUBLIC_APP_URL=http://localhost:3078 bun run verify`: pass; aggregate format, lint, typecheck, unit test, production build, and Playwright gates passed with 214 unit tests and 38 E2E passed / 18 expected skips.
- Docker contract evidence:
  - Real Docker tests ran rather than skipping because Docker was reachable and the `busybox:1.36` fixture image was available or pullable.
  - The real Docker adapter test created one selected-agent container with `agentbay.agent_id=<agentId>`, config/workspace bind mounts, and CPU/memory limits, then inspected exact status, streamed dummy runner logs through `docker logs --timestamps`, stopped the exact stored container ID, and force-removed the test container in cleanup.
- Acceptance evidence map:
  - Server-side adapter contract: `src/server/runners/runner-adapter.ts` defines `start`, `stop`, `restart`, `status`, and `streamLogs`; the local adapter now implements that contract without changing product lifecycle behavior.
  - Docker argument arrays: `DockerRunnerAdapter` accepts an injectable `DockerCliRunner` and all Docker operations pass `string[]` args; mocked tests assert the exact `docker run`, `inspect`, `logs`, and guarded `stop` calls.
  - Container name, label, config/workspace mounts, and resource limits: mocked start coverage asserts the unique `agentbay-<agentId>-<suffix>` name, `agentbay.agent_id` label, read-only config bind, per-agent workspace bind, `--cpus`, and `--memory`; the real Docker contract test exercises the same path.
  - Exact container targeting and label validation: stop/status/log paths resolve the stored container ID from Docker metadata, run `docker inspect --format '{{json .}}' <containerId>`, and refuse mutation/log persistence when the expected agent label mismatches.
  - Deterministic dummy fixture: the default Docker command uses `busybox:1.36` with a deterministic shell loop that prints the selected `AGENTBAY_AGENT_ID`; no Hermes integration is required.
  - Log parsing: timestamped stdout/stderr Docker log output is parsed into durable Docker log rows, duplicate timestamps already persisted for the container are not re-appended, and returned log pages remain container-scoped.
  - Scope boundaries: lifecycle endpoints/UI still use the local runner; crash reconciliation, deleted-agent cleanup, Milestone 10 acceptance, cloud/auth/billing/Hermes/Telegram/provider work, and dependency changes remain out of scope.

#### #77

- Date: 2026-07-04
- Environment:
  - Docker daemon: reachable; `docker info --format '{{.ServerVersion}}'` returned `29.3.1`.
  - Isolated database: container `agentbay_issue_77`, host port `54377`, `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54377/agentbay`.
  - Isolated app/test server: `PORT=3077`, `PLAYWRIGHT_BASE_URL=http://localhost:3077`, `NEXT_PUBLIC_APP_URL=http://localhost:3077`.
- Setup:
  - `test -d node_modules && echo node_modules-present || echo node_modules-missing`: pass; reported `node_modules-missing` before setup.
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile.
  - `docker ps -a --filter name=agentbay_issue_77 --format '{{.Names}} {{.Status}} {{.Ports}}'`: pass; no existing #77 container was present before setup.
  - `docker run --name agentbay_issue_77 -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54377:5432 -d postgres:17-alpine`: pass; started isolated Postgres for #77.
  - `docker exec agentbay_issue_77 pg_isready -U agentbay -d agentbay`: pass; Postgres accepted connections.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54377/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3077 bun run db:migrate`: pass; migrations applied successfully. Postgres emitted a notice that Drizzle's long `agent_logs_docker_runner_container_id...` FK identifier was truncated.
- Implementation checks:
  - `bun run db:generate`: pass; generated the additive Docker runtime metadata migration, then the SQL file was renamed to `drizzle/0006_docker_runner_metadata.sql` and the Drizzle journal tag was updated to match.
  - `bun run format`: pass; Biome formatted 84 files and fixed edited files.
  - `bun run typecheck`: pass; `tsc --noEmit` completed successfully.
  - `bun run test -- tests/unit/agent-logs-route.test.ts tests/unit/agent-schema.test.ts`: pass; 2 files and 31 tests passed for schema shape and safe public log route DTOs.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54377/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3077 bun run test -- tests/unit/create-agent-db.test.ts`: pass; 1 file and 82 tests passed, including Docker metadata persistence, exact-container cross-agent log isolation, source/metadata log rows, and metadata redaction.
- Required gates:
  - `bun run format:check`: pass; Biome checked 84 files.
  - `bun run lint`: pass; Biome checked 84 files.
  - `bun run typecheck`: pass; `tsc --noEmit` passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54377/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3077 bun run test`: pass; 23 files and 205 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54377/agentbay PORT=3077 PLAYWRIGHT_BASE_URL=http://localhost:3077 NEXT_PUBLIC_APP_URL=http://localhost:3077 bun run build`: pass; Next.js production build completed and included dashboard, agent detail, lifecycle, approval, log, health, and settings routes.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54377/agentbay PORT=3077 PLAYWRIGHT_BASE_URL=http://localhost:3077 NEXT_PUBLIC_APP_URL=http://localhost:3077 bun run test:e2e`: pass; full browser suite passed with 38 tests and 18 expected skips.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54377/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3077 bun run db:health`: pass; returned `status: ok` and `database: reachable`.

#### #76

- Date: 2026-07-04
- Environment:
  - Docker daemon: reachable; `docker info --format '{{.ServerVersion}}'` returned `29.3.1`.
  - Isolated database: Compose project `agentbay_issue_76`, container `agentbay_issue_76-postgres-1`, host port `54376`, `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54376/agentbay`.
  - Isolated app/test server: `PORT=3076`, `PLAYWRIGHT_BASE_URL=http://localhost:3076`, `NEXT_PUBLIC_APP_URL=http://localhost:3076`.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile because this worktree had no local `node_modules`.
  - `COMPOSE_PROJECT_NAME=agentbay_issue_76 COMPOSE_FILE=compose.yaml:/tmp/agentbay-issue-76-compose.override.yaml docker compose up -d postgres`: pass; started isolated Postgres with the requested compose path and an issue-specific port override to avoid collisions with default `54329`.
  - `docker exec agentbay_issue_76-postgres-1 pg_isready -U agentbay -d agentbay`: pass; Postgres accepted connections.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54376/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3076 bun run db:migrate`: pass; migrations applied successfully against the isolated #76 database.
- Changelog scope:
  - `rg -n "^# Changelog|Keep a Changelog|^## \[Unreleased\]|^### (Added|Changed|Deprecated|Removed|Fixed|Security)$" CHANGELOG.md`: pass; `CHANGELOG.md` has top-level `# Changelog`, Keep a Changelog framing, `## [Unreleased]`, and non-empty qualifying `### Added` and `### Fixed` sections.
  - `CHANGELOG.md` was intentionally left unchanged because #76 adds gate classification/tracking and no user/operator-visible behavior.
- Focused checks:
  - `bun test tests/unit/docker-availability.test.ts`: pass; 1 file and 4 tests passed for available Docker, missing CLI, unreachable daemon, and empty server-version classification.
- Required gates:
  - `bun run format:check`: pass; Biome checked 80 files.
  - `bun run lint`: pass; Biome checked 80 files.
  - `bun run typecheck`: pass; `tsc --noEmit` passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54376/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3076 bun run test`: pass; 22 files and 181 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54376/agentbay PORT=3076 PLAYWRIGHT_BASE_URL=http://localhost:3076 NEXT_PUBLIC_APP_URL=http://localhost:3076 bun run build`: pass; Next.js build completed and included dashboard, agent detail, lifecycle, approval decision, log, health, and settings routes.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54376/agentbay PORT=3076 PLAYWRIGHT_BASE_URL=http://localhost:3076 NEXT_PUBLIC_APP_URL=http://localhost:3076 bun run test:e2e`: pass; 37 browser tests passed with 17 expected skips.
- Reconciliation:
  - Initial `bun run format:check` failed because this worktree had no local `node_modules` and `biome` was unavailable; `bun install --frozen-lockfile` installed committed dependencies and the rerun passed.

## Milestone 8 Mobile Control Panel Readiness

- Status: Milestone 8 is implementation-complete through #70 and ready for checker review.
- Source plan: `docs/MILESTONES.md` Milestone 8
- Tracking issues: #65-#70
- Current branch: `codex/issue-70-m8-mobile-acceptance`
- Next step: checker should review #70 final mobile acceptance proof, checklist, and gate evidence.

### Issue Checklist

- [x] #65 Audit Milestone 8 readiness and tracking
- [x] #66 Make agent status and pause/resume mobile-ready
- [x] #67 Add mobile approval review and decisions
- [x] #68 Surface mobile latest logs and alerts
- [x] #69 Harden mobile control layouts
- [x] #70 Verify Milestone 8 mobile acceptance
- Later Milestone 8 issue agents must append new issue rows here before implementation evidence if GitHub adds more Milestone 8 work.

### Current Status

- #66 adds a phone-specific `/agents` card list that keeps long agent names, template labels, template keys, IDs, statuses, and action messages wrapped within the viewport while preserving the existing desktop table.
- #66 mobile cards expose current status plus only quick lifecycle controls in scope for the status: `Resume` for `idle`, `stopped`, or `error` agents through the existing start action, and `Stop` for `running` agents through the existing stop action.
- #66 mobile Stop requires a second explicit `Confirm stop` click before mutation and includes a cancel path; Delete is not rendered as a mobile card action.
- #66 adds mobile Playwright coverage proving a long-name stopped agent can resume to running, require confirmation before stopping, stop to `stopped`, and resume again without horizontal page overflow.
- #67 adds shared dashboard/detail approval cards with title, description, agent link, status, requester, created/expiry timestamps, and an allowlisted fake-runner payload summary while keeping unknown payloads generic.
- #67 adds coordinated approval decision controls so mobile users can Approve or Deny from dashboard or detail, see resolved `approved`/`denied` card state, and cannot act on the same resolved card twice.
- #67 treats mobile Deny as irreversible enough to require native confirmation on phone/coarse-pointer viewports while preserving the existing desktop no-confirm refresh behavior.
- #67 adds mobile Playwright coverage for approving from `/dashboard`, denying from `/agents/:agentId`, safe stale already-resolved feedback, no raw payload/driver details, and no horizontal overflow.
- #68 changes the selected agent detail runtime panel to show latest-first bounded log summaries, retaining the existing scoped `GET /api/agents/:agentId/logs` data path and avoiding raw stack frames, database URLs, secret-looking assignments, and unbounded JSON in summaries.
- #68 adds an agent-detail operational alerts panel derived only from the selected active agent's status, pending or expired approvals, and alert-relevant selected-agent events; cross-agent approvals/events are filtered out before rendering.
- #68 documents runner offline/degraded alerts as deferred in the UI until runner state exists in a runner milestone, while still showing available agent, event, and approval blockers now.
- #68 adds unit coverage for alert derivation/redaction and mobile Playwright coverage at iPhone-sized `375x667` and small Android `360x740` widths, proving readable logs/alerts, safe summaries, selected-agent scoping, and no horizontal overflow.
- #69 reuses the `/agents` mobile status card list on the dashboard so persisted-agent status controls do not disappear when the wide desktop table is hidden on phone widths.
- #69 adds defensive mobile layout hardening for shared panels, approval titles/links/actions, action messages, wrapped button labels, and visible focus outlines without changing desktop table behavior.
- #69 adds mobile Playwright coverage that visits `/agents`, `/dashboard`, and `/agents/:agentId` at iPhone-sized `375x667` and small Android `360x740` widths with long agent names, IDs, approval titles/descriptions, status reasons, log lines, and alert messages, proving visible core controls and no horizontal document overflow.
- #70 adds final mobile acceptance Playwright coverage that runs the Milestone 8 checklist at iPhone-sized `375x667` and small Android `360x740` widths, including readable/actionable agent cards, Resume, confirmed Stop, dashboard mobile status controls, detail latest logs, detail operational alerts, Approve, Deny with mobile confirmation, and no horizontal overflow.
- #70 marks Milestone 8 completed in `docs/MILESTONES.md`, keeps `CHANGELOG.md` limited to the qualifying user-visible #66-#69 behavior entries, and adds no new APIs, schema/migrations, dependencies, lockfile changes, provider/runner/auth/billing/secret behavior, or Milestone 9/10 behavior.
- No required Milestone 3-7 predecessor contract is missing. Milestone 8 is ready for checker verification after passing #70 final gates.

### Final Acceptance Checklist

- [x] On a phone viewport, the agent list is readable and actionable.
- [x] User can stop or resume an agent without layout issues.
- [x] User can approve or deny a request from mobile.
- [x] Latest logs and alerts are readable.
- [x] No core mobile controls are hidden behind desktop-only UI.
- [x] Responsive viewport checks cover iPhone-sized `375x667` and small Android-sized `360x740` widths.
- [x] Mobile approval flow and mobile pause/resume flow are covered by Playwright tests.
- [x] `CHANGELOG.md` contains only qualifying user-visible Milestone 8 behavior entries and no empty Keep a Changelog headings.
- [x] Final validation runs against the isolated migrated #70 database on host port `54370`.

### Predecessor Contract Audit

- Agent lifecycle actions: available through `POST /api/agents/:agentId/actions/start`, `POST /api/agents/:agentId/actions/stop`, `POST /api/agents/:agentId/actions/restart`, development-only `POST /api/agents/:agentId/actions/simulate-error`, and `DELETE /api/agents/:agentId`; services in `src/server/agents/lifecycle.ts` validate UUIDs, block invalid status transitions, mutate active non-deleted agents, and write lifecycle audit events.
- Agent status reads: available on the dashboard and agent detail through `listActiveAgentsForDevelopmentUser` and `getActiveAgentForDevelopmentUser` in `src/server/agents/list-agents.ts`; both settle due fake-runner transitions before returning active non-deleted records and expose persisted status plus detail status reason.
- Pending approvals: available through `listPendingApprovalsForDevelopmentUser` for the dashboard and `listPendingApprovalsForDevelopmentUserAgent` for detail pages in `src/server/approvals/agent-approvals.ts`; both return only `pending` approvals for active non-deleted local-development agents and omit raw `payload_json`.
- Approve/deny actions: available through `POST /api/approvals/:approvalId/approve` and `POST /api/approvals/:approvalId/deny`; both validate approval UUIDs, scope decisions to the active local-development user's agent, return safe not-found/conflict/persistence errors, resolve only pending rows, and write exactly one matching `approval.approved` or `approval.denied` event transactionally.
- Latest logs: available through `GET /api/agents/:agentId/logs` and `listAgentLogs` in `src/server/logs/agent-logs.ts`; reads validate active agent scope, cap limits at 100, use per-agent `after` sequence pagination, return oldest-first log DTOs, and generate deterministic fake runtime logs only while the selected active local-development agent is running.
- Event/activity or alert-relevant reads: available through dashboard latest activity via `listLatestAgentActivity`, detail activity via `GET /api/agents/:agentId/events`, and event helpers in `src/server/events/agent-events.ts`; feeds are newest-first, cursor-paginated, safe DTOs over `agent_events`, including lifecycle, config, approval, and error event types that Milestone 8 can use for alert derivation if no dedicated alert model is justified.
- Existing coverage evidence: Milestone 7 validation already covered dashboard/detail approval visibility, approve, deny, decision event counts, duplicate-decision conflicts, pending queue removal, safe UI/API output, runtime-log-triggered fake approval generation, and full aggregate gates against an isolated migrated database.

### Validation

#### #70

- Date: 2026-07-04
- Environment:
  - Isolated database: container `agentbay_issue_70-postgres` on host port `54370`, `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54370/agentbay`.
  - Isolated app/test server: `PORT=3070`, `PLAYWRIGHT_BASE_URL=http://localhost:3070`, `NEXT_PUBLIC_APP_URL=http://localhost:3070`.
- Setup:
  - `docker info --format '{{.ServerVersion}}'`: pass; Docker daemon reachable with server version `29.3.1`.
  - `docker run --name agentbay_issue_70-postgres -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54370:5432 -d postgres:17-alpine`: container name already existed during setup; direct inspection showed `agentbay_issue_70-postgres` running on `0.0.0.0:54370->5432/tcp`.
  - `docker exec agentbay_issue_70-postgres pg_isready -U agentbay -d agentbay`: pass; Postgres accepted connections.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54370/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3070 bun run db:migrate`: pass; migrations applied successfully against the isolated #70 database.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54370/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3070 bun run db:health`: pass; returned `status: ok` and `database: reachable`.
- Focused checks:
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54370/agentbay PORT=3070 PLAYWRIGHT_BASE_URL=http://localhost:3070 NEXT_PUBLIC_APP_URL=http://localhost:3070 bun run test:e2e -- --project=chromium-mobile -g "Milestone 8 mobile acceptance"`: pass; 1 Chromium mobile test passed. Covers `/agents`, `/dashboard`, and `/agents/:agentId` at `375x667` and `360x740`, readable/actionable phone agent cards, Resume, confirmed Stop, dashboard Approve and Deny with persisted statuses, latest log summaries, operational alerts, reachable core controls, and no horizontal overflow.
- Changelog scope:
  - `rg -n "^## |^### " CHANGELOG.md`: pass; only `## [Unreleased]`, `### Added`, and `### Fixed` headings are present, and both sections contain qualifying user-visible entries.
  - `CHANGELOG.md` was intentionally left unchanged because #70 adds validation/docs only; existing Milestone 8 entries are limited to user-visible #66/#67/#68/#69 behavior.
- Required gates:
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54370/agentbay PORT=3070 PLAYWRIGHT_BASE_URL=http://localhost:3070 NEXT_PUBLIC_APP_URL=http://localhost:3070 bun run verify`: pass; aggregate format, lint, typecheck, unit test, build, and E2E gates passed with 177 unit tests and 37 E2E passed / 17 expected skips.

#### #69

- Date: 2026-07-04
- Environment:
  - Isolated database: container `agentbay_issue_69-postgres` on host port `54369`, `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54369/agentbay`.
  - Isolated app/test server: `PORT=3069`, `PLAYWRIGHT_BASE_URL=http://localhost:3069`, `NEXT_PUBLIC_APP_URL=http://localhost:3069`.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile because this worktree had no local `node_modules`.
  - `docker info --format '{{.ServerVersion}}'`: pass; Docker daemon reachable with server version `29.3.1`.
  - `docker run --name agentbay_issue_69-postgres -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54369:5432 -d postgres:17-alpine`: pass; started isolated Postgres for #69.
  - `docker exec agentbay_issue_69-postgres pg_isready -U agentbay -d agentbay`: pass; Postgres accepted connections.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54369/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3069 bun run db:migrate`: pass; migrations applied successfully against the isolated #69 database.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54369/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3069 bun run db:health`: pass; returned `status: ok` and `database: reachable`.
- Focused checks:
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54369/agentbay PORT=3069 PLAYWRIGHT_BASE_URL=http://localhost:3069 NEXT_PUBLIC_APP_URL=http://localhost:3069 bun run test:e2e -- --project=chromium-mobile -g "core mobile control routes"`: pass; 1 Chromium mobile test passed. Covers `/agents`, `/dashboard`, and `/agents/:agentId` at `375x667` and `360x740`, long wrapped names/IDs/approval titles/logs/alerts, dashboard mobile status controls, focusable approval decisions, no mobile Delete quick action, and no horizontal overflow.
- Required gates:
  - `bun run format:check`: pass; Biome checked 78 files.
  - `bun run lint`: pass; Biome checked 78 files.
  - `bun run typecheck`: pass.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54369/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3069 bun run test`: pass; 21 files and 177 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54369/agentbay PORT=3069 PLAYWRIGHT_BASE_URL=http://localhost:3069 NEXT_PUBLIC_APP_URL=http://localhost:3069 bun run build`: pass; Next.js build completed and included dashboard, agent detail, lifecycle, approval decision, log, health, and settings routes.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54369/agentbay PORT=3069 PLAYWRIGHT_BASE_URL=http://localhost:3069 NEXT_PUBLIC_APP_URL=http://localhost:3069 bun run test:e2e`: pass; 36 browser tests passed with 16 expected skips.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54369/agentbay PORT=3069 PLAYWRIGHT_BASE_URL=http://localhost:3069 NEXT_PUBLIC_APP_URL=http://localhost:3069 bun run verify`: pass; aggregate format, lint, typecheck, unit test, build, and E2E gates passed with 177 unit tests and 36 E2E passed / 16 expected skips.
- Reconciliation:
  - Initial `bun run format` failed because the worktree had no local `node_modules`; `bun install --frozen-lockfile` installed committed dependencies and the rerun passed.

#### #68

- Date: 2026-07-04
- Environment:
  - Isolated database: container `agentbay_issue_68-postgres` on host port `54368`, `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54368/agentbay`.
  - Isolated app/test server: `PORT=3068`, `PLAYWRIGHT_BASE_URL=http://localhost:3068`, `NEXT_PUBLIC_APP_URL=http://localhost:3068`.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile because this worktree had no local `node_modules`.
  - `docker info --format '{{.ServerVersion}}'`: pass; Docker daemon reachable with server version `29.3.1`.
  - `docker run --name agentbay_issue_68-postgres -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54368:5432 -d postgres:17-alpine`: pass; started isolated Postgres for #68.
  - `docker exec agentbay_issue_68-postgres pg_isready -U agentbay -d agentbay`: pass; Postgres accepted connections.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54368/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3068 bun run db:migrate`: pass; migrations applied successfully against the isolated #68 database.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54368/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3068 bun run db:health`: pass; returned `status: ok` and `database: reachable`.
- Focused checks:
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54368/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3068 bun run test -- tests/unit/operational-summaries.test.ts tests/unit/root-page.test.tsx`: pass; 2 files and 24 tests passed. Covers scoped alert derivation, runner-state handling, redaction/bounds, safe detail alert rendering, and latest log summary heading rendering.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54368/agentbay PORT=3068 PLAYWRIGHT_BASE_URL=http://localhost:3068 NEXT_PUBLIC_APP_URL=http://localhost:3068 bun run test:e2e -- --project=chromium-mobile -g "mobile latest logs and operational alerts"`: pass; 2 Chromium mobile tests passed. Covers iPhone-sized `375x667` safe latest logs and active alerts plus small Android `360x740` selected-agent log scoping and no horizontal overflow.
- Required gates:
  - `bun run format:check`: pass; Biome checked 78 files.
  - `bun run lint`: pass; Biome checked 78 files.
  - `bun run typecheck`: pass.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54368/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3068 bun run test`: pass; 21 files and 177 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54368/agentbay PORT=3068 PLAYWRIGHT_BASE_URL=http://localhost:3068 NEXT_PUBLIC_APP_URL=http://localhost:3068 bun run build`: pass; Next.js build completed and included agent detail, logs, events, approval decision routes, health, dashboard, and settings routes.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54368/agentbay PORT=3068 PLAYWRIGHT_BASE_URL=http://localhost:3068 NEXT_PUBLIC_APP_URL=http://localhost:3068 bun run test:e2e`: pass; 35 browser tests passed with 15 expected skips.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54368/agentbay PORT=3068 PLAYWRIGHT_BASE_URL=http://localhost:3068 NEXT_PUBLIC_APP_URL=http://localhost:3068 bun run verify`: pass; aggregate format, lint, typecheck, unit test, build, and E2E gates passed with 177 unit tests and 35 E2E passed / 15 expected skips.
- Reconciliation:
  - Initial `bun run format:check` and `bun run typecheck` failed before checks could run because the worktree had no local `node_modules`; `bun install --frozen-lockfile` installed the committed dependencies and the rerun passed.
  - Initial full E2E failed only on stale assertions expecting the old `Runtime logs` heading after #68 renamed the panel to `Latest log summaries`; updating those assertions made the full E2E and aggregate `verify` pass.

#### #67

- Date: 2026-07-04
- Environment:
  - Isolated database: container `agentbay_issue_67-postgres` on host port `54367`, `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54367/agentbay`.
  - Isolated app/test server: `PORT=3067`, `PLAYWRIGHT_BASE_URL=http://localhost:3067`, `NEXT_PUBLIC_APP_URL=http://localhost:3067`.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile because this worktree had no local `node_modules`.
  - `docker info --format '{{.ServerVersion}}'`: pass; Docker daemon reachable with server version `29.3.1`.
  - `docker run --name agentbay_issue_67-postgres -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54367:5432 -d postgres:17-alpine`: pass; started isolated Postgres for #67.
  - `docker exec agentbay_issue_67-postgres pg_isready -U agentbay -d agentbay`: pass; Postgres accepted connections.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54367/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3067 bun run db:migrate`: pass; migrations applied successfully against the isolated #67 database.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54367/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3067 bun run db:health`: pass; returned `status: ok` and `database: reachable`.
- Focused checks:
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54367/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3067 bun run test -- tests/unit/root-page.test.tsx tests/unit/create-agent-db.test.ts`: pass; 2 files and 85 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54367/agentbay PORT=3067 PLAYWRIGHT_BASE_URL=http://localhost:3067 NEXT_PUBLIC_APP_URL=http://localhost:3067 bun run test:e2e -- --project=chromium-mobile -g "mobile approval"`: pass; 2 Chromium mobile tests passed. Covers dashboard approve resolved state, detail deny confirmation and resolved state, already-resolved safe feedback, disabled stale actions, safe payload summary, and no horizontal overflow.
- Required gates:
  - `bun run format:check`: pass; Biome checked 76 files.
  - `bun run lint`: pass; Biome checked 76 files.
  - `bun run typecheck`: pass.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54367/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3067 bun run test`: pass; 20 files and 173 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54367/agentbay PORT=3067 PLAYWRIGHT_BASE_URL=http://localhost:3067 NEXT_PUBLIC_APP_URL=http://localhost:3067 bun run build`: pass; Next.js build completed and included dashboard, agent detail, approval decision routes, health, logs, and lifecycle routes.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54367/agentbay PORT=3067 PLAYWRIGHT_BASE_URL=http://localhost:3067 NEXT_PUBLIC_APP_URL=http://localhost:3067 bun run test:e2e`: pass; 33 browser tests passed with 13 expected skips.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54367/agentbay PORT=3067 PLAYWRIGHT_BASE_URL=http://localhost:3067 NEXT_PUBLIC_APP_URL=http://localhost:3067 bun run verify`: pass; aggregate format, lint, typecheck, unit test, build, and E2E gates passed with 173 unit tests and 33 E2E passed / 13 expected skips.
- Reconciliation:
  - An initial focused DB unit command without `DATABASE_URL`/`NEXT_PUBLIC_APP_URL` failed environment validation before tests ran; rerunning with the isolated #67 environment passed.
  - `bun run format:check` initially reported formatting drift in the new E2E assertions; `bun run format` fixed the single file before final checks.

#### #66

- Date: 2026-07-04
- Environment:
  - Isolated database: container `agentbay_issue_66-postgres` on host port `54366`, `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54366/agentbay`.
  - Isolated app/test server: `PORT=3066`, `PLAYWRIGHT_BASE_URL=http://localhost:3066`, `NEXT_PUBLIC_APP_URL=http://localhost:3066`.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile because this worktree had no local `node_modules`.
  - `docker info --format '{{.ServerVersion}}'`: pass; Docker daemon reachable with server version `29.3.1`.
  - `docker run --name agentbay_issue_66-postgres -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54366:5432 -d postgres:17-alpine`: pass; started isolated Postgres for #66.
  - `docker exec agentbay_issue_66-postgres pg_isready -U agentbay -d agentbay`: pass; Postgres accepted connections.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54366/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3066 bun run db:migrate`: pass; migrations applied successfully against the isolated #66 database.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54366/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3066 bun run db:health`: pass; returned `status: ok` and `database: reachable`.
- Focused checks:
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54366/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3066 bun run test -- tests/unit/root-page.test.tsx`: pass; 1 file and 20 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54366/agentbay PORT=3066 PLAYWRIGHT_BASE_URL=http://localhost:3066 NEXT_PUBLIC_APP_URL=http://localhost:3066 bun run test:e2e -- --project=chromium-mobile -g "mobile list exposes status controls"`: pass; 1 Chromium mobile test passed. Covers long mobile card content, no horizontal overflow, no mobile Delete action, Resume through existing start behavior, Stop confirmation before mutation, stopped status after confirmation, and a second Resume to running.
- Required gates:
  - `bun run format:check`: pass; Biome checked 77 files.
  - `bun run lint`: pass; Biome checked 77 files.
  - `bun run typecheck`: pass.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54366/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3066 bun run test`: pass; 20 files and 173 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54366/agentbay PORT=3066 PLAYWRIGHT_BASE_URL=http://localhost:3066 NEXT_PUBLIC_APP_URL=http://localhost:3066 bun run build`: pass; Next.js build completed and included `/agents`, lifecycle action routes, dashboard, logs, approvals, health, and detail routes.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54366/agentbay PORT=3066 PLAYWRIGHT_BASE_URL=http://localhost:3066 NEXT_PUBLIC_APP_URL=http://localhost:3066 bun run test:e2e`: pass; 31 browser tests passed with 11 expected skips.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54366/agentbay PORT=3066 PLAYWRIGHT_BASE_URL=http://localhost:3066 NEXT_PUBLIC_APP_URL=http://localhost:3066 bun run verify`: pass; aggregate format, lint, typecheck, unit test, build, and E2E gates passed with 173 unit tests and 31 E2E passed / 11 expected skips.
- Reconciliation:
  - An initial focused mobile E2E assertion waited for the transient `Resume requested.` status message, but the fake runner can settle to `running` before that message is observed. The final test asserts durable running/stopped states and keeps the confirmation message assertion for the explicit Stop intent step.

#### #65

- Date: 2026-07-04
- Environment:
  - Isolated database: container `agentbay_issue_65-postgres` on host port `54365`, `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54365/agentbay`.
  - Isolated app/test server: `PORT=3065`, `PLAYWRIGHT_BASE_URL=http://localhost:3065`, `NEXT_PUBLIC_APP_URL=http://localhost:3065`.
  - Isolated environment was used instead of `docker compose up -d postgres` so the checker can reuse a named issue-specific container without conflicting with the default `54329` development database.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile because this worktree had no local `node_modules`.
  - `docker info --format '{{.ServerVersion}}'`: pass; Docker daemon reachable with server version `29.3.1`.
  - `docker run --name agentbay_issue_65-postgres -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54365:5432 -d postgres:17-alpine`: pass; started isolated Postgres for #65.
  - `docker exec agentbay_issue_65-postgres pg_isready -U agentbay -d agentbay`: pass; Postgres accepted connections.
- Changelog structure:
  - `rg -n "^# Changelog|Keep a Changelog|^## \[Unreleased\]|^### (Added|Changed|Deprecated|Removed|Fixed|Security)$" CHANGELOG.md`: pass; `CHANGELOG.md` has top-level `# Changelog`, Keep a Changelog/Semantic Versioning framing, `## [Unreleased]`, and non-empty `### Added` and `### Fixed` sections.
- Required gates:
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54365/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3065 bun run db:migrate`: pass; migrations applied successfully against the isolated #65 database.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54365/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3065 bun run db:health`: pass; returned `status: ok` and `database: reachable`.
  - `bun run format:check`: pass; Biome checked 76 files.
  - `bun run lint`: pass; Biome checked 76 files.
  - `bun run typecheck`: pass.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54365/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3065 bun run test`: pass; 20 files and 173 tests passed.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54365/agentbay PORT=3065 PLAYWRIGHT_BASE_URL=http://localhost:3065 NEXT_PUBLIC_APP_URL=http://localhost:3065 bun run build`: pass; Next.js build completed and included lifecycle, approvals, events, logs, dashboard, health, and agent detail routes.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54365/agentbay PORT=3065 PLAYWRIGHT_BASE_URL=http://localhost:3065 NEXT_PUBLIC_APP_URL=http://localhost:3065 bun run test:e2e`: pass; 30 browser tests passed with 10 expected skips.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54365/agentbay PORT=3065 PLAYWRIGHT_BASE_URL=http://localhost:3065 NEXT_PUBLIC_APP_URL=http://localhost:3065 bun run verify`: pass; aggregate format, lint, typecheck, unit test, build, and E2E gates passed with 173 unit tests and 30 E2E passed / 10 expected skips.

## Milestone 7 Approval Queue

- Status: complete for #59/#60/#61/#62/#63/#64
- Source plan: `docs/MILESTONES.md` Milestone 7
- Tracking issues: #59-#64
- Current branch: `codex/issue-64-m7-acceptance`

### Issue Checklist

- [x] #59 Show pending approvals on the dashboard
- [x] #60 Approve pending approvals end to end
- [x] #61 Deny pending approvals end to end
- [x] #62 Show pending approvals on agent detail
- [x] #63 Generate fake approvals for running agents
- [x] #64 Verify Milestone 7 approval queue acceptance
- Later Milestone 7 issue agents must append new issue rows here before implementation evidence if GitHub adds more Milestone 7 work.

### Completion Evidence

- [x] #59 adds an additive `agent_approvals` table with `id`, `agent_id`, `title`, `description`, `status`, `payload_json`, `requested_by`, `resolved_by`, `created_at`, `resolved_at`, and `expires_at`.
- [x] #59 adds the exact `agent_approval_status` lifecycle values: `pending`, `approved`, `denied`, `expired`, and `cancelled`.
- [x] #59 adds local-development approval helpers that create pending approvals only for active existing agents owned by the local development user and list only pending approvals for active non-deleted local-development agents.
- [x] #59 keeps resolved approvals, soft-deleted-agent approvals, and other-user approvals out of the dashboard pending queue.
- [x] #59 renders a dashboard pending approvals panel from persisted data with agent identity/link, title, description, status, created time, and expiry when present.
- [x] #59 keeps raw `payload_json`, database internals, SQL, driver messages, stack traces, credentials, and environment values out of dashboard output and safe persistence errors.
- [x] #59 updates README and CHANGELOG to describe the dashboard pending approval queue as present behavior while leaving the remaining Milestone 7 slices to #60-#64.
- [x] #60 adds `POST /api/approvals/:approvalId/approve` with safe validation, not-found, conflict, success, and persistence-failure JSON responses.
- [x] #60 transactionally resolves one pending local-development approval to `approved`, records `resolved_by` and `resolved_at`, and writes exactly one `approval.approved` event with safe approval/agent metadata.
- [x] #60 rolls back the approval update when approval-approved event writing fails, and repeated approval attempts return `approval_already_resolved` without duplicate decision events.
- [x] #60 adds a dashboard Approve control that posts only through the approve route, keeps safe error text on failures, refreshes after success, and removes the resolved row from the pending queue.
- [x] #60 documents the shared already-resolved conflict shape for #61/#64 as HTTP 409 with `approval_already_resolved` and safe current status.
- [x] #62 adds an agent-scoped pending approval read helper for the selected active local-development agent.
- [x] #62 renders a read-only agent-detail pending approvals panel with title, description, `pending` status, requester/source, created time, optional expiry, empty state, and safe error state.
- [x] #62 keeps resolved approvals, other-agent approvals, soft-deleted-agent approvals, and other-user approvals out of the selected detail page.
- [x] #62 keeps the agent record, config editor, runtime logs, and activity visible when approval loading fails.
- [x] #62 updates README and CHANGELOG to describe agent-detail approval visibility as present behavior while leaving approve/deny decisions and fake approval generation to sibling Milestone 7 slices.
- [x] #63 extends the pull-driven fake runner observation path so active, non-deleted, running local-development agents can generate one deterministic pending approval for a representative fake sensitive action.
- [x] #63 prevents duplicate generated approvals and duplicate `approval.requested` events for the same running segment/action, while still allowing later running segments to generate their own bounded request.
- [x] #63 excludes stopped, idle, pending-transition, error, deleting, missing, soft-deleted, and other-user agents from fake approval generation.
- [x] #63 persists only safe fake payload preview fields: source, action type, preview summary fields, and running-segment timestamp; no credentials, tokens, provider payloads, raw prompts, database URLs, SQL, or environment values are stored or rendered.
- [x] #63 writes exactly one low-volume `approval.requested` audit event transactionally with the generated approval insert and does not mirror runtime log lines into `agent_events`.
- [x] #63 keeps approve/deny routes, decision controls/events, and agent-detail approval sections out of scope for #60/#61/#62.
- [x] #61 adds `POST /api/approvals/:approvalId/deny` with safe validation, not-found, already-resolved conflict, success, and persistence-failure JSON responses.
- [x] #61 denies exactly one pending approval for the active local-development user, updates status to `denied`, records `resolved_by` and `resolved_at`, and writes exactly one `approval.denied` event in the same transaction.
- [x] #61 rolls back the approval update if the decision event write fails, leaving the approval `pending` with no resolver fields and no partial `approval.denied` event.
- [x] #61 returns the reusable `approval_already_resolved` conflict shape with a safe current status for denied or otherwise resolved approvals and writes no duplicate decision events.
- [x] #61 adds dashboard Deny controls for pending approvals with safe requesting/error/success states; successful denial refreshes the dashboard pending queue and removes the resolved row.
- [x] #61 keeps approve behavior, payload execution, raw `payload_json`, SQL/driver details, stacks, credentials, provider internals, and new schema/migration changes out of scope.
- [x] #64 adds final Milestone 7 acceptance coverage proving the same active non-deleted local-development agent's pending approvals are visible on `/dashboard` and `/agents/:agentId` without raw payloads, SQL/driver details, database URLs, stacks, credentials, or provider internals.
- [x] #64 proves approving a pending approval resolves it to `approved`, removes it from pending approval queues, and leaves exactly one `approval.approved` event.
- [x] #64 proves denying a pending approval resolves it to `denied`, removes it from pending approval queues, and leaves exactly one `approval.denied` event.
- [x] #64 proves repeated approve and deny requests against already resolved approved or denied approvals return the shared `approval_already_resolved` conflict shape and do not create duplicate decision events.
- [x] #64 closes Milestone 7 acceptance without adding schema, migrations, dependencies, lockfile changes, provider execution, runner behavior, auth, billing, secrets, or mobile-specific approval flows.

### Validation

#### #64

- Date: 2026-07-04
- Environment:
  - Isolated database: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54364/agentbay`.
  - Isolated app/test server: `PORT=3064`, `PLAYWRIGHT_BASE_URL=http://localhost:3064`, `NEXT_PUBLIC_APP_URL=http://localhost:3064`.
- Focused checks:
  - `bun run test:e2e -- --project=chromium-desktop -g "Milestone 7 acceptance"`: pass with isolated DB/app env; 1 Chromium desktop test passed. Covers dashboard and agent-detail visibility for the same active local-development agent, approve resolution to `approved`, deny resolution to `denied`, pending queue removal for both seeded approval rows, exactly one `approval.approved` event, exactly one `approval.denied` event, shared `approval_already_resolved` responses for repeated approve/deny against resolved approvals, no duplicate decision events, and safe UI/API output without raw payloads, SQL/driver details, database URLs, stacks, credentials, or provider internals.
- Required gates:
  - `bun run format:check`: pass; Biome checked 76 files.
  - `bun run lint`: pass; Biome checked 76 files.
  - `bun run typecheck`: pass.
  - `bun run test`: pass with isolated DB/app env; 20 files and 173 tests passed.
  - `bun run build`: pass; Next.js build completed and included `/api/approvals/[approvalId]/approve`, `/api/approvals/[approvalId]/deny`, `/dashboard`, and `/agents/[agentId]`.
  - `bun run test:e2e`: pass with isolated DB/app env; 30 browser tests passed with 10 expected skips.
  - `bun run verify`: pass with isolated DB/app env; aggregate format, lint, typecheck, unit test, build, and E2E gates passed with 173 unit tests and 30 E2E passed / 10 expected skips.

#### #60

- Date: 2026-07-04
- Environment:
  - Default Postgres port `54329` was occupied by local Docker listener `com.docke` PID `53372`.
  - Default app port `3000` was occupied by local `node` process `60238`.
  - Isolated database: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54360/agentbay`.
  - Isolated app/test server: `PORT=3060`, `PLAYWRIGHT_BASE_URL=http://localhost:3060`, `NEXT_PUBLIC_APP_URL=http://localhost:3060`.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile because this worktree had no local `node_modules`.
  - `docker info --format '{{.ServerVersion}}'`: pass; Docker daemon reachable with server version `29.3.1`.
  - `docker run --name agentbay_issue_60-postgres -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54360:5432 -d postgres:17-alpine`: pass; started isolated Postgres because default port was occupied.
  - `docker exec agentbay_issue_60-postgres pg_isready -U agentbay -d agentbay`: pass; Postgres accepted connections.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54360/agentbay bun run db:migrate`: pass; migrations applied successfully against the isolated database.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54360/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3060 bun run db:health`: pass; returned `status: ok` and `database: reachable`.
- Focused checks:
  - `bun run test -- tests/unit/create-agent-db.test.ts tests/unit/approve-approval-route.test.ts tests/unit/root-page.test.tsx`: pass with isolated DB/app env; 3 files and 86 tests passed. Covers approve success, malformed ID, not found/inaccessible approvals, already resolved conflict, duplicate event prevention, event-write rollback, safe route response mapping, dashboard Approve control rendering, and safe dashboard error state.
  - `bun run test:e2e -- --project=chromium-desktop -g "approve"`: pass with isolated DB/app env; 2 Chromium desktop tests passed. Covers dashboard approve success, pending-row removal after refresh, `approval.approved` activity evidence, and safe client failure text that leaves the pending row readable.

#### #61

- Date: 2026-07-04
- Environment:
  - Default Postgres port `54329` was occupied by existing Docker container `agentbay-postgres-1`.
  - Default app port `3000` was occupied by local `node` process `60238`.
  - Isolated database: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54361/agentbay`.
  - Isolated app/test server: `PORT=3061`, `PLAYWRIGHT_BASE_URL=http://localhost:3061`, `NEXT_PUBLIC_APP_URL=http://localhost:3061`.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile because this worktree had no local `node_modules`.
  - `docker run --name agentbay_issue_61-postgres -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54361:5432 -d postgres:17-alpine`: pass; started isolated Postgres after a stalled `postgres:16-alpine` pull was interrupted.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54361/agentbay bun run db:migrate`: pass; migrations applied successfully against the isolated database.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54361/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3061 bun run db:health`: pass; returned `status: ok` and `database: reachable`.
- Focused checks:
  - `bun run test -- tests/unit/create-agent-db.test.ts tests/unit/approve-approval-route.test.ts tests/unit/deny-approval-route.test.ts tests/unit/root-page.test.tsx`: pass after rebasing on #60 with isolated DB/app env; 4 files and 97 tests passed. Covers approve preservation, deny success, resolver fields, exactly one safe `approval.denied` event, malformed id, not found/inaccessible approval, already resolved conflict, duplicate-event prevention, event-write rollback, route response mapping, dashboard Approve/Deny control render, and safe dashboard approval-load failures.
  - `bun run test:e2e -- --project=chromium-desktop -g "denies a pending approval"`: pass with isolated DB/app env; proves dashboard Deny control safe error text, successful denial, pending-row removal after refresh, and visible `approval.denied` activity evidence without raw payload internals.
- Required gates:
  - `bun run format:check`: pass; Biome checked 76 files.
  - `bun run lint`: pass; Biome checked 76 files.
  - `bun run typecheck`: pass.
  - `bun run test`: pass with isolated DB/app env; 20 files and 173 tests passed.
  - `bun run build`: pass; Next.js build completed and included `/api/approvals/[approvalId]/approve`, `/api/approvals/[approvalId]/deny`, and `/dashboard`.
  - `bun run test:e2e`: pass with isolated DB/app env; 29 browser tests passed with 9 expected skips.
  - `bun run verify`: pass with isolated DB/app env after rebasing on #60; aggregate format, lint, typecheck, unit test, build, and E2E gates passed with 173 unit tests and 29 E2E passed / 9 expected skips.

#### #63

- Date: 2026-07-04
- Environment:
  - Default Postgres port `54329` was occupied by local Docker listener `com.docke` PID `53372`.
  - Default app port `3000` was occupied by local `node` process `60238`.
  - Isolated database: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54363/agentbay`.
  - Isolated app/test server: `PORT=3063`, `PLAYWRIGHT_BASE_URL=http://localhost:3063`, `NEXT_PUBLIC_APP_URL=http://localhost:3063`.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile because this worktree had no local `node_modules`.
  - `docker info --format '{{.ServerVersion}}'`: pass; Docker daemon reachable with server version `29.3.1`.
  - `docker run --name agentbay_issue_63-postgres -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54363:5432 -d postgres:17-alpine`: pass; started isolated Postgres because default port was occupied.
  - `docker exec agentbay_issue_63-postgres pg_isready -U agentbay -d agentbay`: pass; Postgres accepted connections.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54363/agentbay bun run db:migrate`: pass; migrations applied successfully against the isolated database.
  - `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54363/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3063 bun run db:health`: pass; returned `status: ok` and `database: reachable`.
- Focused checks:
  - `bun run test -- tests/unit/create-agent-db.test.ts tests/unit/agent-logs-route.test.ts tests/unit/root-page.test.tsx`: pass with isolated DB/app env; 3 files and 89 tests passed. Covers running-agent generation, non-running/missing/soft-deleted/other-user exclusion, duplicate prevention, safe payload shape, `approval.requested` metadata, approval/event rollback, logs-route generation, and dashboard safe rendering.
  - `bun run test:e2e -- --project=chromium-desktop -g "fake approvals"`: pass with isolated DB/app env; proves observing a running agent through `GET /api/agents/:agentId/logs` creates a generated pending approval visible on `/dashboard` without raw payload internals and with `approval.requested` activity.
  - `bun run test:e2e -- --project=chromium-desktop -g "scoped runtime logs"`: pass with isolated DB/app env after making the existing runtime-log proof explicitly pin the local-development user before route observation; this avoids parallel E2E races over the shared local-development-user pointer.
- Required gates:
  - `bun run format:check`: pass; Biome checked 70 files.
  - `bun run lint`: pass; Biome checked 70 files.
  - `bun run typecheck`: pass.
  - `bun run test`: pass with isolated DB/app env; 18 files and 148 tests passed.
  - `bun run build`: pass; Next.js build completed and included `/api/agents/:agentId/logs` and `/dashboard`.
  - `bun run test:e2e`: pass with isolated DB/app env; 25 browser tests passed with 5 expected skips.
  - `bun run verify`: pass with isolated DB/app env; aggregate format, lint, typecheck, unit test, build, and E2E gates passed with 148 unit tests and 25 E2E passed / 5 expected skips.
- Reconciliation:
  - Full E2E initially exposed shared local-development-user pointer races once fake generation became user-scoped. The final tests pin the selected agent immediately before logs-route observation and scope dashboard assertions to the specific generated approval item, while leaving product behavior unchanged.

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

- Status: complete locally on `codex/milestone-5-agent-templates`
- Source plan: `docs/MILESTONES.md` Milestone 5
- Tracking issues: #48-#53
- Current branch: `codex/milestone-5-agent-templates`

### Issue Checklist

- [x] #48 Initialize Milestone 5 progress and changelog tracking
- [x] #49 Add the typed agent template registry
- [x] #50 Persist template versions and snapshots on agents
- [x] #51 Show template metadata in the create-agent flow
- [x] #52 Show persisted template settings on agent detail
- [x] #53 Prove Milestone 5 template acceptance end to end
- Later Milestone 5 issue agents must append new issue rows here before implementation evidence if GitHub adds more Milestone 5 work.

### Current Status

Milestone 5 is implemented locally as metadata-only template behavior. The source registry exposes exactly `research_agent`, `inbox_triage_agent`, `github_issue_agent`, and `social_content_agent` with version `1.0.0`, names, descriptions, default tools, manual schedules, default prompts, and empty required integration lists.

Agent creation now stores `template_key`, `template_version`, and immutable `template_snapshot_json`, initializes the editable config prompt from the selected template default prompt, and records template version in the `agent.created` event metadata. The create flow renders template metadata from the registry, and agent detail renders the persisted snapshot so later registry edits do not silently change existing agent displays.

No tool, model-provider, runner, auth, billing, secret, or integration execution was added for Milestone 5.

### Tracking Rules

- Update `PROGRESS.md` for each Milestone 5 issue with status, branch, implementation evidence, validation commands, and any skipped checks or blockers.
- Update `CHANGELOG.md` only for user-visible functional changes. Do not add changelog entries for chores, tests, validation-only work, tracking-only edits, or empty headings.
- Keep Milestone 5 implementation evidence separate from older Milestone 4 history below this section.

### Update Log

- 2026-07-04: #48 initialized Milestone 5 tracking from `docs/MILESTONES.md`, recorded the #48-#53 checklist, documented the stale-context check for existing root tracking files, and recorded the `CHANGELOG.md` update rule. `CHANGELOG.md` was left unchanged because it already has the required Keep a Changelog preamble and `## [Unreleased]` section.
- 2026-07-05: #49-#53 implemented on `codex/milestone-5-agent-templates`. Added typed template registry, backfill-safe template snapshot migration, create-agent snapshot persistence, create-flow metadata display, detail-page persisted template settings, focused registry/schema/API/persistence/UI tests, and marked `docs/MILESTONES.md` Milestone 5 complete.

### Validation

- `bun run db:migrate`: pass; applied `drizzle/0007_plain_hedge_knight.sql` with existing-agent snapshot backfill.
- `bun run db:health`: pass; local Postgres reachable.
- `bun run typecheck`: pass.
- `DATABASE_URL=${DATABASE_URL:-postgres://agentbay:agentbay@127.0.0.1:54329/agentbay} NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL:-http://localhost:3000} bun run test -- tests/unit/agent-templates.test.ts tests/unit/create-agent-validation.test.ts tests/unit/agent-schema.test.ts tests/unit/create-agent-route.test.ts tests/unit/create-agent-db.test.ts tests/unit/root-page.test.tsx`: pass; 145 tests passed.
- `bun run db:generate`: pass; no schema changes, nothing to migrate.
- `bun run format:check`: pass.
- `bun run lint`: pass.
- `DATABASE_URL=${DATABASE_URL:-postgres://agentbay:agentbay@127.0.0.1:54329/agentbay} NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL:-http://localhost:3000} bun run test`: pass; 227 unit tests passed.
- `DATABASE_URL=${DATABASE_URL:-postgres://agentbay:agentbay@127.0.0.1:54329/agentbay} NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL:-http://localhost:3000} bun run build`: pass.
- `DATABASE_URL=${DATABASE_URL:-postgres://agentbay:agentbay@127.0.0.1:54329/agentbay} NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL:-http://localhost:3000} bun run test:e2e -- --project=chromium-desktop -g "/agents creates Research Agent and persists it across read surfaces"`: pass; Milestone 5 browser proof passed.
- `DATABASE_URL=${DATABASE_URL:-postgres://agentbay:agentbay@127.0.0.1:54329/agentbay} NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL:-http://localhost:3000} bun run test:e2e`: pass on rerun; 39 E2E passed / 19 expected skips.
- `DATABASE_URL=${DATABASE_URL:-postgres://agentbay:agentbay@127.0.0.1:54329/agentbay} NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL:-http://localhost:3000} bun run verify`: one aggregate retry failed during E2E on two transient Docker start waits (`Agent could not be started.`); the same focused create/read test passed before the retry and the full E2E suite passed immediately after.

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
