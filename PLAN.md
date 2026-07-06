# Implementation Plan

## Source Documents

- Path: `/Users/alexmetelli/source/agentbay/docs/MILESTONES.md`
  - Role: Acceptance-criteria source for Milestone 13.
  - Summary: Milestone 13 requires a DigitalOcean cloud runner flow where the user clicks Create runner, sees persisted provisioning progress, a Droplet is created, cloud-init installs and registers the runner, the dashboard shows the runner `online`, users can create or assign agents to the new runner, and provisioning failures are visible and actionable.
- Path: `inline user brief, 2026-07-06`
  - Role: Primary implementation brief and production diagnosis.
  - Summary: Production testing proved Droplet creation works, but the runner never becomes assignable because the bootstrap uses `http://127.0.0.1:3045`, does not expose a public HTTPS runner endpoint, lacks durable credential persistence and continuous heartbeat, has a short token TTL for slow cheap Droplets, has weak bootstrap failure visibility, and start falls back to local Docker on Vercel instead of reporting runner-not-ready state.

## Goals

- Complete Milestone 13 cloud provisioning end to end for the existing DigitalOcean-only MVP.
- Create a runner from the deployed app and show refresh-safe progress through Droplet creation, bootstrap, registration, heartbeat, and `online` readiness.
- Make the provisioned Droplet reachable by Vercel over HTTPS for agent lifecycle commands.
- Ensure a user can create an agent and have start/assignment use the new online cloud runner instead of Vercel-local Docker.
- Show actionable failure states for DigitalOcean API failures and post-Droplet bootstrap/register timeout failures.
- Keep DigitalOcean provider credentials, one-time registration tokens, runner credentials, and command bearer material server-side or Droplet-local only.

## Non-Goals

- Do not add non-DigitalOcean cloud providers.
- Do not implement BYO cloud accounts.
- Do not complete Milestone 14 multi-agent capacity beyond the minimum needed to place one agent on one online cloud runner.
- Do not complete Milestone 15 backup/restore work.
- Do not replace all runner command authentication with a full per-command signed request protocol in this milestone; use a pragmatic command bearer token with a clearly documented follow-up if needed.
- Do not build a background worker platform beyond the smallest timeout/reconciliation mechanism needed for Milestone 13.

## Definition of Done

- `POST /api/runners` and the Create Runner UI create a DigitalOcean Droplet and persist provisioning phases through `pending`, `bootstrapping`, `creating`, `tagging`, `firewall_configuring`, `waiting_for_runner`, and `ready`, with refresh-safe display on Settings and Dashboard.
- The app polls or reads the Droplet public IPv4 after creation and registers a public HTTPS endpoint such as `https://<public-ip>.sslip.io` rather than `127.0.0.1`.
- Cloud-init installs Docker, Bun, repository dependencies, a reverse proxy/TLS endpoint on ports 80/443, and the long-running runner service.
- The cloud runner exchanges the one-time registration token, persists `AGENTBAY_RUNNER_ID` and `AGENTBAY_RUNNER_CREDENTIAL` on the Droplet, sends an initial heartbeat, and continues heartbeating after service restarts.
- The dashboard and settings show the runner as `online` after heartbeat, with endpoint host and latest heartbeat visible without secrets.
- A newly created stopped agent can be started on the online DigitalOcean runner; the agent is assigned to the runner, lifecycle command traffic reaches the Droplet, and the agent transitions to `running`.
- If no online runner exists in production, Start does not attempt local Docker on Vercel; it returns a safe `runner_not_ready` or `no_online_runner` response and the UI shows a clear message.
- If Droplet bootstrap/register/heartbeat does not complete before the configured timeout, provisioning transitions to `failed` with an actionable operator message and safe cleanup/manual cleanup guidance.
- Production environment requirements are documented and verified: `DATABASE_URL`, `NEXT_PUBLIC_APP_URL`, `AGENTBAY_DIGITALOCEAN_TOKEN`, `AGENTBAY_DIGITALOCEAN_SIZE_SLUG`, and `AGENTBAY_RUNNER_BEARER_TOKEN` or its replacement command-auth setting.
- A real smoke test on the target Vercel deployment demonstrates: Create runner progress, Droplet created, runner online, agent creation/start on that runner, and visible actionable failure behavior through a controlled fake/provider test path.
- Required quality gates pass or any pre-existing failures are explicitly documented in `PROGRESS.md`.
- `PROGRESS.md` is current after every step and `CHANGELOG.md` contains only user/operator-visible functional changes under `## [Unreleased]`.

## Assumptions and Open Questions

- Assumption: The project will continue using the cheapest DigitalOcean size `s-1vcpu-512mb-10gb` if swap makes bootstrap reliable. If reliability remains poor, switch the default minimum supported size to `s-1vcpu-1gb` and document the cost tradeoff.
- Assumption: `sslip.io` is acceptable for MVP public HTTPS hostnames. If product needs branded domains later, defer that to a separate milestone.
- Assumption: The repository is publicly cloneable from the Droplet. Production testing showed `git ls-remote https://github.com/ametel01/agentbay.git HEAD` succeeds without credentials.
- Assumption: A shared `AGENTBAY_RUNNER_BEARER_TOKEN` is acceptable for Milestone 13 command auth if kept server-side and Droplet-local. A per-runner command credential design should be tracked separately.
- Open question: Whether to auto-start agents after a runner becomes online or require the user to click Start again. Conservative plan: do not auto-start; show pending/runner-not-ready state and let the user start once the runner is online.
- Open question: Whether failed provisioned Droplets should always be deleted automatically. Conservative plan: clean up only when the provider resource is known and no runner credential/heartbeat has been observed; otherwise show manual cleanup instructions.

## Implementation Approach

- Keep the existing DigitalOcean provider abstraction and provisioning state model. Add the missing readiness and reachability behavior rather than replacing the whole workflow.
- Treat the Droplet public endpoint as a first-class provisioning output. After Droplet creation, fetch or poll the Droplet until a public IPv4 exists, then compute `https://<ip>.sslip.io` and use that endpoint for registration and lifecycle commands.
- Keep the runner service bound to `127.0.0.1:3045` on the Droplet and install a reverse proxy that terminates HTTPS on ports 80/443 and forwards to the local service.
- Make the runner bootstrap idempotent: if `AGENTBAY_RUNNER_ID` and `AGENTBAY_RUNNER_CREDENTIAL` already exist, skip registration and heartbeat with the existing credential.
- Add continuous heartbeat in the long-running runner service rather than relying only on bootstrap. Include capacity metrics compatible with existing runner placement.
- Add a timeout/reconciliation path for cloud runners stuck in `waiting_for_runner`, either through an API-read reconciliation helper invoked by cloud runner panels/routes or a small server-side helper used by relevant pages and tests.
- Change production lifecycle behavior so no-runner placement is explicit. Local development can keep Docker fallback; deployed production should return a safe no-runner/runner-not-ready response.
- Keep changes covered by unit tests first, then focused E2E tests, then one real smoke against Vercel/DigitalOcean.

## Quality Gates

- Setup status: Existing gates are configured in `package.json`, `biome.json`, `vitest.config.ts`, `playwright.config.ts`, and `tsconfig.json`; no new quality-gate setup step is required.
- Baseline command: `bun run format:check && bun run lint && bun run typecheck && bun run test -- tests/unit/digitalocean-provider.test.ts tests/unit/runner-provisioning.test.ts tests/unit/cloud-runner-bootstrap.test.ts tests/unit/runner-registration.test.ts tests/unit/runner-heartbeat.test.ts tests/unit/runner-service-bootstrap.test.ts tests/unit/runner-service.test.ts tests/unit/runner-placement.test.ts tests/unit/start-agent-route.test.ts tests/unit/create-agent-db.test.ts`
- Format command: `bun run format:check`
- Lint command: `bun run lint`
- Test command: `bun run test -- tests/unit/digitalocean-provider.test.ts tests/unit/runner-provisioning.test.ts tests/unit/cloud-runner-bootstrap.test.ts tests/unit/runner-registration.test.ts tests/unit/runner-heartbeat.test.ts tests/unit/runner-service-bootstrap.test.ts tests/unit/runner-service.test.ts tests/unit/runner-placement.test.ts tests/unit/start-agent-route.test.ts tests/unit/create-agent-db.test.ts`
- Additional gates: `bun run typecheck`, `bun run build`, `PLAYWRIGHT_REUSE_EXISTING_SERVER=0 PORT=3100 bun run test:e2e -- --grep "cloud runner|runner|agent.*start" --project=chromium-desktop`
- Final full gate before completion: `bun run verify`
- Real smoke gate: deploy to Vercel production or preview with required env vars, create one DigitalOcean runner, verify Droplet creation, runner online heartbeat, agent start on the runner, then clean up any smoke Droplet if the app does not own it safely.

## Progress Tracking

- File: `PROGRESS.md`
- Requirement: Create `PROGRESS.md` before any implementation work begins.
- Update rule: After each step is completed, update `PROGRESS.md` with the completed step, validation results, commit reference if available, current status, and next step.

## Changelog Tracking

- File: `CHANGELOG.md`
- Standard: Keep a Changelog 1.0.0, <https://keepachangelog.com/en/1.0.0/>
- Requirement: Ensure `CHANGELOG.md` exists before any implementation work begins. The file already exists; preserve existing entries and update only for shipped functional changes.
- Initial content: If missing, add `# Changelog`, the standard preamble, and an `## [Unreleased]` section.
- Update rule: After each step is completed and validated, update `CHANGELOG.md` before creating that step's commit only if the step shipped a functional change. Omit entries for chores, progress tracking, implementation plans, docs-only updates, tests or coverage, CI or validation runs, framework migration housekeeping, and empty category headings.

## Goal Handoff

- Readiness: This plan is ready to be used as a `/goal` payload.
- Scope: The `/goal` should execute only the work described in this plan unless the user explicitly expands it.
- Done: The `/goal` is complete only when every item in `## Definition of Done` is satisfied, all incremental steps are complete, required quality gates pass or documented pre-existing failures are handled, `PROGRESS.md` and `CHANGELOG.md` are current, and the final state is summarized for the user.

## Incremental Steps

### Step 0: Progress and Changelog Tracking Setup

Goal: Create durable progress and changelog files the user can consult while the plan is executed.

Changes:
- Create `PROGRESS.md` in the project root.
- Add this plan title, sources, a step checklist, current status, and a short update log.
- Document that `PROGRESS.md` must be updated after every completed step.
- Confirm `CHANGELOG.md` exists and follows Keep a Changelog 1.0.0 conventions. If it is missing, create it with `# Changelog`, the standard preamble, and `## [Unreleased]`.
- Document that `CHANGELOG.md` is updated only for validated functional changes.

Validation:
- Confirm `PROGRESS.md` exists and contains the step checklist.
- Confirm `CHANGELOG.md` exists and contains `# Changelog` and `## [Unreleased]`.

Progress:
- Mark Step 0 complete in `PROGRESS.md`, record validation results, set current status, and identify Step 1 as next.

Changelog:
- Do not add a changelog entry for progress and changelog tracking setup because it is not a functional change.

Commit:
- `chore: add milestone 13 progress tracking`

### Step 1: Baseline Characterization and Failing Tests

Goal: Capture the current Milestone 13 failure modes in tests before changing behavior.

Depends on:
- Step 0

Changes:
- Add or update focused tests in `tests/unit/cloud-runner-bootstrap.test.ts`, `tests/unit/runner-provisioning.test.ts`, `tests/unit/runner-service-bootstrap.test.ts`, `tests/unit/runner-service.test.ts`, `tests/unit/runner-placement.test.ts`, `tests/unit/start-agent-route.test.ts`, and `tests/unit/create-agent-db.test.ts`.
- Characterize that cloud runner bootstrap must not register `127.0.0.1` as its public endpoint.
- Characterize that a provisioning runner stuck in `waiting_for_runner` eventually becomes failed with an actionable error.
- Characterize that production agent start with no online runner must not fall back to Docker.
- Characterize expected assignment/start once a DigitalOcean runner is `online`.

Acceptance Criteria:
- Tests fail against the current implementation for missing public endpoint, missing continuous heartbeat/credential persistence, no bootstrap timeout, and production Docker fallback.
- Tests do not require live DigitalOcean.

Definition of Done Advancement:
- Establishes executable criteria for the remaining Milestone 13 fixes.

Validation:
- Run `bun run format:check`
- Run `bun run lint`
- Run `bun run typecheck`
- Run `bun run test -- tests/unit/cloud-runner-bootstrap.test.ts tests/unit/runner-provisioning.test.ts tests/unit/runner-service-bootstrap.test.ts tests/unit/runner-service.test.ts tests/unit/runner-placement.test.ts tests/unit/start-agent-route.test.ts tests/unit/create-agent-db.test.ts`

Progress:
- Update `PROGRESS.md` with completed characterization tests, expected failing/pass status, current status, and Step 2 as next.

Changelog:
- Do not add a changelog entry because characterization tests alone are not shipped behavior.

Commit:
- `test: characterize milestone 13 cloud runner gaps`

### Step 2: Public Droplet Endpoint and HTTPS Proxy Bootstrap

Goal: Provisioned cloud runners register a Vercel-reachable HTTPS endpoint.

Depends on:
- Step 1

Changes:
- Update `src/server/runners/digitalocean-provider.ts` and `src/server/runners/digitalocean-sdk-runtime.js` if needed to support Droplet read/polling for public IPv4 after create.
- Update `src/server/runners/runner-provisioning.ts` to wait for or resolve the Droplet public IPv4 and compute `https://<ip>.sslip.io`.
- Update `src/server/runners/cloud-runner-bootstrap.ts` to install and configure a reverse proxy, preferably Caddy for automatic TLS, forwarding `https://<ip>.sslip.io` to `127.0.0.1:3045`.
- Keep the runner service bound to loopback; expose only 80/443 through the firewall.
- Update provider/firewall tests to verify only intended ports are configured.
- Update `tests/unit/cloud-runner-bootstrap.test.ts`, `tests/unit/runner-provisioning.test.ts`, and `tests/unit/digitalocean-provider.test.ts`.

Acceptance Criteria:
- Bootstrap content includes reverse proxy install/config for the computed public hostname.
- Runner registration endpoint URL is no longer `127.0.0.1`.
- Provisioning records retain the provider resource ID and public endpoint host safely.

Definition of Done Advancement:
- Unblocks Vercel-to-runner lifecycle command reachability.

Validation:
- Run `bun run format:check`
- Run `bun run lint`
- Run `bun run typecheck`
- Run `bun run test -- tests/unit/digitalocean-provider.test.ts tests/unit/runner-provisioning.test.ts tests/unit/cloud-runner-bootstrap.test.ts`
- Run `bun run build`

Progress:
- Update `PROGRESS.md` with endpoint/proxy completion notes, validation results, commit reference if available, current status, and Step 3 as next.

Changelog:
- Update `CHANGELOG.md` under `## [Unreleased]` with a `Changed` or `Fixed` entry for cloud runners registering public HTTPS endpoints.

Commit:
- `fix: provision public https endpoints for cloud runners`

### Step 3: Reliable Cheap-Droplet Bootstrap Runtime

Goal: Make bootstrap complete reliably on `s-1vcpu-512mb-10gb` or deliberately choose a safer minimum size.

Depends on:
- Step 2

Changes:
- Update `src/server/runners/cloud-runner-bootstrap.ts` to add a swapfile before heavy package installs when the configured size is the cheapest low-memory size.
- Make cloud-init shell commands fail fast and log enough status locally for operator inspection.
- Extend cloud registration token TTL for cloud provisioning in `src/server/runners/runner-provisioning.ts` or the registration-token helper path to 60 minutes while preserving one-time use.
- Update `src/server/env.ts` only if the implementation chooses `s-1vcpu-1gb` as the supported minimum instead of adding swap.
- Update unit tests in `tests/unit/cloud-runner-bootstrap.test.ts`, `tests/unit/runner-provisioning.test.ts`, and `tests/unit/runner-registration.test.ts`.

Acceptance Criteria:
- Bootstrap user-data includes swap setup or the default DigitalOcean size is explicitly raised and tested.
- Cloud provisioning registration tokens have a longer TTL than manual tokens and remain one-time use.
- No provider credential, raw registration token, or runner credential appears in safe summaries or UI.

Definition of Done Advancement:
- Reduces the risk that the Droplet exists but never registers due to install time or memory pressure.

Validation:
- Run `bun run format:check`
- Run `bun run lint`
- Run `bun run typecheck`
- Run `bun run test -- tests/unit/cloud-runner-bootstrap.test.ts tests/unit/runner-provisioning.test.ts tests/unit/runner-registration.test.ts tests/unit/server-env.test.ts`
- Run `bun run build`

Progress:
- Update `PROGRESS.md` with bootstrap reliability decision, validation results, commit reference if available, current status, and Step 4 as next.

Changelog:
- Update `CHANGELOG.md` under `## [Unreleased]` with a `Changed` entry for more reliable cloud runner bootstrap on the selected Droplet size.

Commit:
- `fix: make cloud runner bootstrap reliable on small droplets`

### Step 4: Durable Registration Credential Persistence

Goal: A cloud runner persists its exchanged identity and credential on the Droplet and survives service restarts.

Depends on:
- Step 3

Changes:
- Update `src/runner-service/bootstrap.ts` so after successful registration it writes or updates `AGENTBAY_RUNNER_ID` and `AGENTBAY_RUNNER_CREDENTIAL` in `/etc/agentbay/runner.env` or a configured env file path.
- Ensure file permissions remain `0600`.
- Make bootstrap idempotent: if runner ID and credential already exist, skip registration and send heartbeat with the existing credential.
- Update cloud-init in `src/server/runners/cloud-runner-bootstrap.ts` to pass the env file path to bootstrap if needed.
- Update tests in `tests/unit/runner-service-bootstrap.test.ts` and `tests/unit/cloud-runner-bootstrap.test.ts`.

Acceptance Criteria:
- First bootstrap exchanges the one-time token and persists visible-once credential values only on the Droplet.
- Re-running bootstrap does not reuse the one-time registration token.
- Safe logs and summaries redact `agb_reg_*` and `agb_run_*`.

Definition of Done Advancement:
- Makes runner registration durable and restart-safe.

Validation:
- Run `bun run format:check`
- Run `bun run lint`
- Run `bun run typecheck`
- Run `bun run test -- tests/unit/runner-service-bootstrap.test.ts tests/unit/cloud-runner-bootstrap.test.ts tests/unit/runner-registration.test.ts tests/unit/runner-heartbeat.test.ts`
- Run `bun run build`

Progress:
- Update `PROGRESS.md` with credential persistence notes, validation results, commit reference if available, current status, and Step 5 as next.

Changelog:
- Update `CHANGELOG.md` under `## [Unreleased]` with a `Fixed` entry for cloud runner registration surviving service restarts.

Commit:
- `fix: persist cloud runner registration credentials`

### Step 5: Continuous Runner Heartbeat and Capacity Metrics

Goal: The long-running runner service keeps the cloud runner `online` and supplies placement capacity.

Depends on:
- Step 4

Changes:
- Update `src/runner-service/index.ts` or add a helper module under `src/runner-service/` to send heartbeat on startup and every configured interval.
- Read `AGENTBAY_APP_URL`, `AGENTBAY_RUNNER_ID`, and `AGENTBAY_RUNNER_CREDENTIAL` from the env file environment.
- Include status `online`, version, and capacity metrics compatible with `src/server/runners/runner-placement.ts`.
- Ensure heartbeat loop failures do not kill the command server unless configuration is missing at startup.
- Update `tests/unit/runner-service.test.ts`, `tests/unit/runner-heartbeat.test.ts`, and `tests/unit/runner-placement.test.ts`.

Acceptance Criteria:
- A registered runner continues sending heartbeat after bootstrap.
- Heartbeat updates the runner to `online` and `ready`.
- Capacity metrics are visible to placement and UI.

Definition of Done Advancement:
- Enables Dashboard to show `online` and enables agent placement.

Validation:
- Run `bun run format:check`
- Run `bun run lint`
- Run `bun run typecheck`
- Run `bun run test -- tests/unit/runner-service.test.ts tests/unit/runner-heartbeat.test.ts tests/unit/runner-placement.test.ts tests/unit/cloud-runner-provisioning.test.ts`
- Run `bun run build`

Progress:
- Update `PROGRESS.md` with heartbeat behavior, validation results, commit reference if available, current status, and Step 6 as next.

Changelog:
- Update `CHANGELOG.md` under `## [Unreleased]` with an `Added` entry for continuous cloud runner heartbeat.

Commit:
- `feat: add continuous heartbeat for cloud runners`

### Step 6: Command Authentication for Cloud Runner Lifecycle Calls

Goal: Vercel can authenticate start/stop/restart/status/log requests to the cloud runner without exposing command credentials in the browser.

Depends on:
- Step 5

Changes:
- Add or validate server env handling for `AGENTBAY_RUNNER_BEARER_TOKEN` in `src/server/env.ts` or existing validation paths if needed.
- Update `src/server/runners/cloud-runner-bootstrap.ts` to inject `AGENTBAY_RUNNER_BEARER_TOKEN` into the Droplet env file from server-side env.
- Ensure `src/runner-service/server.ts` continues to require the bearer token for lifecycle command routes.
- Update Vercel/operator docs in `README.md` or deployment notes with required production env var.
- Update tests in `tests/unit/server-env.test.ts`, `tests/unit/cloud-runner-bootstrap.test.ts`, `tests/unit/manual-runner-adapter.test.ts`, and `tests/unit/runner-service.test.ts`.

Acceptance Criteria:
- AgentBay server can call the cloud runner lifecycle API with the configured bearer token.
- The token is not rendered in browser HTML, JSON DTOs, safe summaries, or logs.
- Missing token produces a clear server/operator failure before a runner is incorrectly considered usable.

Definition of Done Advancement:
- Enables agent start commands to reach and authenticate to the online cloud runner.

Validation:
- Run `bun run format:check`
- Run `bun run lint`
- Run `bun run typecheck`
- Run `bun run test -- tests/unit/server-env.test.ts tests/unit/cloud-runner-bootstrap.test.ts tests/unit/manual-runner-adapter.test.ts tests/unit/runner-service.test.ts tests/unit/start-agent-route.test.ts`
- Run `bun run build`

Progress:
- Update `PROGRESS.md` with command-auth notes, validation results, commit reference if available, current status, and Step 7 as next.

Changelog:
- Update `CHANGELOG.md` under `## [Unreleased]` with a `Changed` entry for cloud runner command authentication requirements.

Commit:
- `fix: inject command auth for cloud runners`

### Step 7: Bootstrap Timeout, Failure State, and Cleanup Guidance

Goal: A Droplet that never registers becomes a visible, actionable provisioning failure instead of staying in progress forever.

Depends on:
- Step 2
- Step 5

Changes:
- Add a reconciliation helper in `src/server/runners/runner-provisioning.ts` or `src/server/runners/cloud-runner-provisioning.ts` that finds `waiting_for_runner` cloud runners older than a configurable timeout.
- Mark timed-out runners `provision_failed` / provisioning `failed` with a specific safe error message.
- Record a `failed` provisioning event through `src/server/runners/runner-provisioning-events.ts`.
- Add cleanup where safe using existing DigitalOcean cleanup paths, and otherwise surface manual cleanup instructions with provider resource ID.
- Invoke reconciliation from dashboard/settings cloud runner reads or an explicit route used by those pages, avoiding a new worker unless necessary.
- Update `app/_components/cloud-runner-provisioning-panel.tsx`, `app/settings/page.tsx`, and `app/dashboard/page.tsx` if UI messaging needs adjustment.
- Update tests in `tests/unit/runner-provisioning.test.ts`, `tests/unit/cloud-runner-provisioning.test.ts`, and `tests/unit/root-page.test.tsx`.

Acceptance Criteria:
- Timed-out bootstrap/register failures become `failed`.
- UI message distinguishes provider API failure from post-Droplet runner registration failure.
- Failure message gives next action and does not include secrets.

Definition of Done Advancement:
- Completes the actionable failure acceptance criterion for bootstrap failures.

Validation:
- Run `bun run format:check`
- Run `bun run lint`
- Run `bun run typecheck`
- Run `bun run test -- tests/unit/runner-provisioning.test.ts tests/unit/cloud-runner-provisioning.test.ts tests/unit/root-page.test.tsx tests/unit/cloud-runner-route.test.ts`
- Run `bun run build`

Progress:
- Update `PROGRESS.md` with timeout/failure handling notes, validation results, commit reference if available, current status, and Step 8 as next.

Changelog:
- Update `CHANGELOG.md` under `## [Unreleased]` with a `Fixed` entry for stalled cloud runner provisioning becoming actionable.

Commit:
- `fix: mark stalled cloud runner bootstrap as failed`

### Step 8: Production No-Runner Behavior and Agent Assignment UX

Goal: Agent start/create behavior uses online cloud runners and avoids Docker fallback on Vercel.

Depends on:
- Step 5
- Step 6

Changes:
- Update `src/server/agents/lifecycle.ts` so no-online-runner placement returns a distinct result in production instead of falling back to `DockerRunnerAdapter`.
- Preserve local Docker fallback for local development if useful, guarded by environment/runtime detection or explicit configuration.
- Update `app/api/agents/[agentId]/actions/start/route.ts` to return a safe `runner_not_ready` or `no_online_runner` response.
- Update `app/agents/_components/start-agent-button.tsx` to show “No online runner is available yet” or “Runner is still provisioning” instead of the generic failure.
- Ensure `src/server/runners/runner-placement.ts` assigns newly started agents to eligible online DigitalOcean runners.
- Update agent list/detail UI if needed to show assigned runner state.
- Update tests in `tests/unit/start-agent-route.test.ts`, `tests/unit/create-agent-db.test.ts`, `tests/unit/runner-placement.test.ts`, and `tests/unit/root-page.test.tsx`.

Acceptance Criteria:
- With an online DigitalOcean runner, a stopped agent start reserves capacity, assigns `runner_id`, calls the runner adapter, and transitions to running.
- With only a provisioning/registering runner, start returns a clear runner-not-ready response and does not attempt Docker on Vercel.
- UI shows useful action text for both states.

Definition of Done Advancement:
- Completes the agent create/assign/start acceptance criterion once runner online is available.

Validation:
- Run `bun run format:check`
- Run `bun run lint`
- Run `bun run typecheck`
- Run `bun run test -- tests/unit/start-agent-route.test.ts tests/unit/create-agent-db.test.ts tests/unit/runner-placement.test.ts tests/unit/root-page.test.tsx`
- Run `PLAYWRIGHT_REUSE_EXISTING_SERVER=0 PORT=3100 bun run test:e2e -- --grep "cloud runner|agent.*start" --project=chromium-desktop`
- Run `bun run build`

Progress:
- Update `PROGRESS.md` with assignment UX notes, validation results, commit reference if available, current status, and Step 9 as next.

Changelog:
- Update `CHANGELOG.md` under `## [Unreleased]` with `Fixed` or `Changed` entries for production runner-not-ready handling and cloud runner assignment.

Commit:
- `fix: route production agent starts through online runners`

### Step 9: End-to-End Cloud Provisioning Smoke and Operator Docs

Goal: Prove Milestone 13 against a real Vercel deployment and a real small DigitalOcean Droplet.

Depends on:
- Step 8

Changes:
- Update `README.md` or `docs/` deployment notes with production env vars, DigitalOcean token requirements, runner command auth requirement, expected provisioning phases, and cleanup instructions.
- Add or update a focused Playwright smoke or manual smoke script if feasible without creating real Droplets in normal CI.
- Deploy to Vercel preview or production with required env vars.
- Run one real smoke:
  - `GET /health` returns reachable DB.
  - Create runner from UI or `POST /api/runners`.
  - Verify DigitalOcean Droplet exists and has expected tags, size, region, and public IPv4.
  - Verify settings/dashboard progress reaches `ready`.
  - Verify dashboard/settings show runner `online`.
  - Create a new agent.
  - Start the agent and verify assignment to the DigitalOcean runner plus `running` status.
  - Exercise a controlled failure path through fake provider/unit path or a safe misconfiguration test in non-production.
- Clean up any extra smoke Droplets not owned by successful app state.

Acceptance Criteria:
- All Milestone 13 acceptance criteria are verified in production-like conditions.
- Operator docs describe required env and failure triage.
- No cloud resources are left orphaned except intentional active runner resources documented in `PROGRESS.md`.

Definition of Done Advancement:
- Final validation that Milestone 13 can be marked complete.

Validation:
- Run `bun run format:check`
- Run `bun run lint`
- Run `bun run typecheck`
- Run `bun run test -- tests/unit/digitalocean-provider.test.ts tests/unit/runner-provisioning.test.ts tests/unit/cloud-runner-bootstrap.test.ts tests/unit/runner-registration.test.ts tests/unit/runner-heartbeat.test.ts tests/unit/runner-service-bootstrap.test.ts tests/unit/runner-service.test.ts tests/unit/runner-placement.test.ts tests/unit/start-agent-route.test.ts tests/unit/create-agent-db.test.ts`
- Run `bun run build`
- Run `bun run verify` before final handoff, or document pre-existing failures with evidence if full E2E is environment-blocked.
- Run the real Vercel/DigitalOcean smoke described above.

Progress:
- Update `PROGRESS.md` with final validation, deployment URL, smoke resource IDs, cleanup status, current status, and final summary.

Changelog:
- Update `CHANGELOG.md` under `## [Unreleased]` with final `Added`, `Changed`, or `Fixed` entries for shipped Milestone 13 behavior. Omit validation-only entries.

Commit:
- `docs: document cloud runner provisioning operations`
